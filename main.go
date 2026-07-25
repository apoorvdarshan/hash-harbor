package main

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/metainfo"
	"github.com/anacrolix/torrent/storage"
)

const (
	host               = "127.0.0.1"
	port               = 3000
	maxBodyBytes       = 16_384
	maxActiveTorrents  = 1
	streamReadahead    = 32 << 20
	transcodeReadahead = 64 << 20
)

//go:embed web/*
var webFiles embed.FS

type torrentFileJSON struct {
	Index      int     `json:"index"`
	Name       string  `json:"name"`
	Path       string  `json:"path"`
	Length     int64   `json:"length"`
	Downloaded int64   `json:"downloaded"`
	Progress   float64 `json:"progress"`
}

type torrentSessionJSON struct {
	ID            string            `json:"id"`
	Name          string            `json:"name"`
	Status        string            `json:"status"`
	Error         *string           `json:"error"`
	MetadataReady bool              `json:"metadataReady"`
	Progress      float64           `json:"progress"`
	Downloaded    int64             `json:"downloaded"`
	Uploaded      int64             `json:"uploaded"`
	DownloadSpeed int64             `json:"downloadSpeed"`
	UploadSpeed   int64             `json:"uploadSpeed"`
	Peers         int               `json:"peers"`
	Length        int64             `json:"length"`
	Files         []torrentFileJSON `json:"files"`
}

// The resolver only exchanges torrent metadata; piece bytes are discarded.
// Keeping it separate mirrors Webtor's resolver/seeder split and prevents disk
// storage from delaying magnet discovery.
type metadataOnlyStorage struct{}

func (metadataOnlyStorage) OpenTorrent(_ context.Context, _ *metainfo.Info, _ metainfo.Hash) (storage.TorrentImpl, error) {
	return storage.TorrentImpl{
		Piece: func(metainfo.Piece) storage.PieceImpl { return metadataOnlyPiece{} },
	}, nil
}

type metadataOnlyPiece struct{}

func (metadataOnlyPiece) ReadAt([]byte, int64) (int, error) { return 0, io.EOF }
func (metadataOnlyPiece) WriteAt(value []byte, _ int64) (int, error) {
	return len(value), nil
}
func (metadataOnlyPiece) MarkComplete() error            { return nil }
func (metadataOnlyPiece) MarkNotComplete() error         { return nil }
func (metadataOnlyPiece) Completion() storage.Completion { return storage.Completion{} }

type session struct {
	id       string
	source   string
	client   *torrent.Client
	torrent  *torrent.Torrent
	dataPath string

	errorMu sync.RWMutex
	err     string

	sampleMu         sync.Mutex
	lastSampleAt     time.Time
	lastReadBytes    int64
	lastWrittenBytes int64
	downloadSpeed    int64
	uploadSpeed      int64
	activeReaders    atomic.Int32
}

func (s *session) setError(err error) {
	s.errorMu.Lock()
	defer s.errorMu.Unlock()
	if err == nil {
		s.err = ""
		return
	}
	s.err = err.Error()
}

func (s *session) errorMessage() *string {
	s.errorMu.RLock()
	defer s.errorMu.RUnlock()
	if s.err == "" {
		return nil
	}
	value := s.err
	return &value
}

func (s *session) rates(stats torrent.TorrentStats) (int64, int64) {
	s.sampleMu.Lock()
	defer s.sampleMu.Unlock()

	now := time.Now()
	readBytes := stats.BytesReadUsefulData.Int64()
	writtenBytes := stats.BytesWrittenData.Int64()
	if s.lastSampleAt.IsZero() {
		s.lastSampleAt = now
		s.lastReadBytes = readBytes
		s.lastWrittenBytes = writtenBytes
		return 0, 0
	}

	elapsed := now.Sub(s.lastSampleAt)
	if elapsed >= 250*time.Millisecond {
		seconds := elapsed.Seconds()
		s.downloadSpeed = int64(float64(max(0, readBytes-s.lastReadBytes)) / seconds)
		s.uploadSpeed = int64(float64(max(0, writtenBytes-s.lastWrittenBytes)) / seconds)
		s.lastSampleAt = now
		s.lastReadBytes = readBytes
		s.lastWrittenBytes = writtenBytes
	}
	return s.downloadSpeed, s.uploadSpeed
}

type gateway struct {
	dataRoot     string
	metadataRoot string
	ffmpegPath   string

	mu       sync.RWMutex
	sessions map[string]*session
}

func newGateway(root string) (*gateway, error) {
	dataRoot := filepath.Join(root, "work", "torrents")
	metadataRoot := filepath.Join(root, "work", "metadata")
	if err := os.MkdirAll(dataRoot, 0o755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(metadataRoot, 0o755); err != nil {
		return nil, err
	}
	ffmpegPath, _ := exec.LookPath("ffmpeg")
	return &gateway{
		dataRoot:     dataRoot,
		metadataRoot: metadataRoot,
		ffmpegPath:   ffmpegPath,
		sessions:     make(map[string]*session),
	}, nil
}

func normalizeSource(value any) (source string, id string, err error) {
	source = strings.TrimSpace(fmt.Sprint(value))
	if source == "" {
		return "", "", errors.New("paste a magnet link or BitTorrent v1 info hash")
	}
	if len(source) > 8_192 {
		return "", "", errors.New("this magnet link is too long")
	}
	if len(source) == 40 || len(source) == 32 {
		source = "magnet:?xt=urn:btih:" + source
	}
	if !strings.HasPrefix(strings.ToLower(source), "magnet:?") {
		return "", "", errors.New("use a magnet link, 40-character hex hash, or 32-character base32 hash")
	}
	magnet, parseErr := metainfo.ParseMagnetUri(source)
	if parseErr != nil || magnet.InfoHash.IsZero() {
		return "", "", errors.New("this magnet does not contain a valid BitTorrent v1 info hash")
	}
	return source, magnet.InfoHash.HexString(), nil
}

func (g *gateway) metadataPath(id string) string {
	return filepath.Join(g.metadataRoot, id+".torrent")
}

func (g *gateway) addTorrent(client *torrent.Client, source, id string) (*torrent.Torrent, error) {
	if cached, err := metainfo.LoadFromFile(g.metadataPath(id)); err == nil {
		t, addErr := client.AddTorrent(cached)
		if addErr != nil {
			return nil, addErr
		}
		if _, mergeErr := client.AddMagnet(source); mergeErr != nil {
			log.Printf("[torrent:%s] cached metadata loaded; tracker merge failed: %v", id, mergeErr)
		}
		log.Printf("[torrent:%s] loaded cached metadata", id)
		return t, nil
	}
	return client.AddMagnet(source)
}

func (g *gateway) createSession(source, id string) (*session, error) {
	dataPath := filepath.Join(g.dataRoot, id)
	if err := os.MkdirAll(dataPath, 0o755); err != nil {
		return nil, err
	}

	config := torrent.NewDefaultClientConfig()
	config.DataDir = dataPath
	config.ListenPort = 0
	config.NoDefaultPortForwarding = true
	config.Seed = false
	config.DisableWebtorrent = false
	config.DisableWebseeds = false
	config.Debug = os.Getenv("HASH_HARBOR_TORRENT_DEBUG") == "1"

	client, err := torrent.NewClient(config)
	if err != nil {
		return nil, fmt.Errorf("start torrent client: %w", err)
	}
	t, err := g.addTorrent(client, source, id)
	if err != nil {
		client.Close()
		return nil, fmt.Errorf("add torrent: %w", err)
	}

	s := &session{
		id:       id,
		source:   source,
		client:   client,
		torrent:  t,
		dataPath: dataPath,
	}
	if t.Info() == nil {
		go g.resolveMetadata(s)
	}
	go g.cacheMetadata(s)
	return s, nil
}

func (g *gateway) resolveMetadata(s *session) {
	config := torrent.NewDefaultClientConfig()
	config.ListenPort = 0
	config.Seed = false
	config.DisableWebtorrent = true
	config.DisableWebseeds = true
	config.DefaultStorage = metadataOnlyStorage{}

	client, err := torrent.NewClient(config)
	if err != nil {
		log.Printf("[resolver:%s] could not start: %v", s.id, err)
		return
	}
	defer client.Close()

	resolved, err := client.AddMagnet(s.source)
	if err != nil {
		log.Printf("[resolver:%s] magnet rejected: %v", s.id, err)
		return
	}
	defer resolved.Drop()

	log.Printf("[resolver:%s] metadata discovery started", s.id)
	select {
	case <-resolved.GotInfo():
		info := resolved.Metainfo()
		if _, err := s.client.AddTorrent(&info); err != nil {
			log.Printf("[resolver:%s] metadata merge failed: %v", s.id, err)
			return
		}
		log.Printf("[resolver:%s] metadata merged", s.id)
	case <-s.torrent.GotInfo():
		log.Printf("[resolver:%s] primary client resolved metadata", s.id)
	case <-s.torrent.Closed():
		return
	}
}

func (g *gateway) cacheMetadata(s *session) {
	select {
	case <-s.torrent.GotInfo():
	case <-s.torrent.Closed():
		return
	}

	target := g.metadataPath(s.id)
	temp, err := os.CreateTemp(g.metadataRoot, s.id+"-*.torrent.tmp")
	if err != nil {
		log.Printf("[torrent:%s] metadata cache create failed: %v", s.id, err)
		return
	}
	tempName := temp.Name()
	defer os.Remove(tempName)

	torrentInfo := s.torrent.Metainfo()
	if err := torrentInfo.Write(temp); err != nil {
		_ = temp.Close()
		log.Printf("[torrent:%s] metadata cache write failed: %v", s.id, err)
		return
	}
	if err := temp.Close(); err != nil {
		log.Printf("[torrent:%s] metadata cache close failed: %v", s.id, err)
		return
	}
	if err := os.Rename(tempName, target); err != nil {
		log.Printf("[torrent:%s] metadata cache rename failed: %v", s.id, err)
		return
	}
	log.Printf("[torrent:%s] metadata cached", s.id)
}

func fraction(done, total int64) float64 {
	if total <= 0 {
		return 0
	}
	return float64(done) / float64(total)
}

func (g *gateway) serialize(s *session) torrentSessionJSON {
	t := s.torrent
	stats := t.Stats()
	downloadSpeed, uploadSpeed := s.rates(stats)
	downloaded := t.BytesCompleted()
	info := t.Info()
	name := t.Name()
	if name == "" {
		name = "Reading metadata…"
	}

	result := torrentSessionJSON{
		ID:            s.id,
		Name:          name,
		Error:         s.errorMessage(),
		MetadataReady: info != nil,
		Downloaded:    downloaded,
		Uploaded:      stats.BytesWrittenData.Int64(),
		DownloadSpeed: downloadSpeed,
		UploadSpeed:   uploadSpeed,
		Peers:         stats.ActivePeers,
		Files:         []torrentFileJSON{},
	}

	if result.Error != nil {
		result.Status = "error"
		return result
	}
	if info == nil {
		result.Status = "finding metadata"
		return result
	}

	result.Length = info.TotalLength()
	result.Progress = fraction(downloaded, result.Length)
	for index, file := range t.Files() {
		fileDownloaded := file.BytesCompleted()
		result.Files = append(result.Files, torrentFileJSON{
			Index:      index,
			Name:       filepath.Base(file.Path()),
			Path:       file.Path(),
			Length:     file.Length(),
			Downloaded: fileDownloaded,
			Progress:   fraction(fileDownloaded, file.Length()),
		})
	}

	switch {
	case result.Length > 0 && downloaded >= result.Length:
		result.Status = "complete"
	case s.activeReaders.Load() > 0 && stats.ActivePeers > 0:
		result.Status = "streaming"
	case s.activeReaders.Load() > 0:
		result.Status = "finding peers"
	default:
		result.Status = "ready"
	}
	return result
}

func sendJSON(response http.ResponseWriter, status int, value any) {
	body, err := json.Marshal(value)
	if err != nil {
		http.Error(response, "unable to encode response", http.StatusInternalServerError)
		return
	}
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Content-Length", strconv.Itoa(len(body)))
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_, _ = response.Write(body)
}

func readJSON(request *http.Request, target any) error {
	defer request.Body.Close()
	decoder := json.NewDecoder(io.LimitReader(request.Body, maxBodyBytes+1))
	if err := decoder.Decode(target); err != nil {
		return errors.New("request must contain valid JSON")
	}
	return nil
}

func contentType(filename string) string {
	extension := strings.ToLower(filepath.Ext(filename))
	known := map[string]string{
		".avi":  "video/x-msvideo",
		".flac": "audio/flac",
		".m4a":  "audio/mp4",
		".m4v":  "video/mp4",
		".mkv":  "video/x-matroska",
		".mov":  "video/quicktime",
		".mp3":  "audio/mpeg",
		".mp4":  "video/mp4",
		".ogg":  "audio/ogg",
		".srt":  "text/plain; charset=utf-8",
		".vtt":  "text/vtt; charset=utf-8",
		".wav":  "audio/wav",
		".webm": "video/webm",
	}
	if value := known[extension]; value != "" {
		return value
	}
	if value := mime.TypeByExtension(extension); value != "" {
		return value
	}
	return "application/octet-stream"
}

func (g *gateway) sessionByID(id string) *session {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.sessions[id]
}

func fileByIndex(s *session, rawIndex string) (*torrent.File, int, error) {
	if s.torrent.Info() == nil {
		return nil, 0, errors.New("torrent metadata is not ready")
	}
	index, err := strconv.Atoi(rawIndex)
	if err != nil || index < 0 {
		return nil, 0, errors.New("invalid torrent file index")
	}
	files := s.torrent.Files()
	if index >= len(files) {
		return nil, 0, errors.New("torrent file not found")
	}
	return files[index], index, nil
}

func startReader(request *http.Request, s *session, file *torrent.File, readahead int64) torrent.Reader {
	reader := file.NewReader()
	reader.SetContext(request.Context())
	reader.SetResponsive()
	reader.SetReadahead(readahead)
	s.activeReaders.Add(1)
	return reader
}

func stopReader(s *session, reader torrent.Reader) {
	_ = reader.Close()
	s.activeReaders.Add(-1)
}

func (g *gateway) serveFile(request *http.Request, response http.ResponseWriter, s *session, file *torrent.File, index int, download bool) {
	reader := startReader(request, s, file, streamReadahead)
	defer stopReader(s, reader)

	response.Header().Set("Accept-Ranges", "bytes")
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", contentType(file.Path()))
	if download {
		response.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{
			"filename": filepath.Base(file.Path()),
		}))
	}

	log.Printf("[stream:%s] file=%d range=%q download=%t", s.id, index, request.Header.Get("Range"), download)
	http.ServeContent(response, request, filepath.Base(file.Path()), time.Unix(0, 0), reader)
}

func (g *gateway) transcodeFile(request *http.Request, response http.ResponseWriter, s *session, file *torrent.File, index int) {
	if g.ffmpegPath == "" {
		sendJSON(response, http.StatusNotImplemented, map[string]string{
			"error": "FFmpeg is required to play this video format in the browser.",
		})
		return
	}

	reader := startReader(request, s, file, transcodeReadahead)
	defer stopReader(s, reader)

	streamContext, cancel := context.WithCancel(request.Context())
	defer cancel()
	reader.SetContext(streamContext)

	command := exec.CommandContext(
		streamContext,
		g.ffmpegPath,
		"-hide_banner",
		"-loglevel", "error",
		"-fflags", "+genpts",
		"-i", "pipe:0",
		"-map", "0:v:0?",
		"-map", "0:a:0?",
		"-c:v", "copy",
		"-c:a", "aac",
		"-b:a", "192k",
		"-movflags", "frag_keyframe+empty_moov+default_base_moof",
		"-f", "mp4",
		"pipe:1",
	)
	stdin, err := command.StdinPipe()
	if err != nil {
		sendJSON(response, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		sendJSON(response, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr

	if err := command.Start(); err != nil {
		sendJSON(response, http.StatusBadGateway, map[string]string{"error": "Unable to start the media converter."})
		return
	}

	copyDone := make(chan error, 1)
	go func() {
		_, copyErr := io.Copy(stdin, reader)
		closeErr := stdin.Close()
		if copyErr != nil {
			copyDone <- copyErr
			return
		}
		copyDone <- closeErr
	}()
	waitDone := make(chan error, 1)
	go func() { waitDone <- command.Wait() }()

	firstChunk := make([]byte, 32<<10)
	readCount, readErr := stdout.Read(firstChunk)
	if readCount == 0 && readErr != nil {
		cancel()
		commandErr := <-waitDone
		message := strings.TrimSpace(stderr.String())
		if message == "" && commandErr != nil {
			message = commandErr.Error()
		}
		log.Printf("[transcode:%s] file=%d failed: %s", s.id, index, message)
		sendJSON(response, http.StatusBadGateway, map[string]string{
			"error": "This media file could not be converted for browser playback.",
		})
		return
	}

	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "video/mp4")
	response.Header().Set("X-Hash-Harbor-Transcoded", "true")
	response.WriteHeader(http.StatusOK)
	if readCount > 0 {
		_, _ = response.Write(firstChunk[:readCount])
	}

	_, streamErr := io.Copy(response, stdout)
	cancel()
	commandErr := <-waitDone
	<-copyDone
	if streamErr != nil && !errors.Is(streamErr, context.Canceled) {
		log.Printf("[transcode:%s] response stopped: %v", s.id, streamErr)
	}
	if commandErr != nil && request.Context().Err() == nil {
		log.Printf("[transcode:%s] converter stopped: %v %s", s.id, commandErr, strings.TrimSpace(stderr.String()))
	}
}

func pathParts(request *http.Request) []string {
	return strings.FieldsFunc(request.URL.Path, func(r rune) bool { return r == '/' })
}

func (g *gateway) handleAPI(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet || strings.Contains(request.URL.Path, "/files/") {
		log.Printf("[http] %s %s", request.Method, request.URL.Path)
	}

	switch {
	case request.Method == http.MethodGet && request.URL.Path == "/health":
		g.mu.RLock()
		count := len(g.sessions)
		g.mu.RUnlock()
		sendJSON(response, http.StatusOK, map[string]any{
			"ok":             true,
			"activeTorrents": count,
			"engine":         "webtor-go",
			"transcoding":    g.ffmpegPath != "",
		})
		return

	case request.Method == http.MethodGet && request.URL.Path == "/api/torrents":
		g.mu.RLock()
		values := make([]torrentSessionJSON, 0, len(g.sessions))
		for _, value := range g.sessions {
			values = append(values, g.serialize(value))
		}
		g.mu.RUnlock()
		sendJSON(response, http.StatusOK, map[string]any{"torrents": values})
		return

	case request.Method == http.MethodPost && request.URL.Path == "/api/torrents":
		var body struct {
			Source              any  `json:"source"`
			PermissionConfirmed bool `json:"permissionConfirmed"`
		}
		if err := readJSON(request, &body); err != nil {
			sendJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if !body.PermissionConfirmed {
			sendJSON(response, http.StatusBadRequest, map[string]string{
				"error": "Confirm that you have permission to access and share this content.",
			})
			return
		}
		source, id, err := normalizeSource(body.Source)
		if err != nil {
			sendJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}

		g.mu.Lock()
		if existing := g.sessions[id]; existing != nil {
			g.mu.Unlock()
			sendJSON(response, http.StatusAccepted, g.serialize(existing))
			return
		}
		if len(g.sessions) >= maxActiveTorrents {
			g.mu.Unlock()
			sendJSON(response, http.StatusTooManyRequests, map[string]string{
				"error": "Stop the current torrent before opening another one.",
			})
			return
		}
		s, createErr := g.createSession(source, id)
		if createErr == nil {
			g.sessions[id] = s
		}
		g.mu.Unlock()
		if createErr != nil {
			sendJSON(response, http.StatusBadRequest, map[string]string{"error": createErr.Error()})
			return
		}
		log.Printf("[torrent:%s] session created", id)
		sendJSON(response, http.StatusAccepted, g.serialize(s))
		return
	}

	parts := pathParts(request)
	if len(parts) < 3 || parts[0] != "api" || parts[1] != "torrents" {
		sendJSON(response, http.StatusNotFound, map[string]string{"error": "Route not found."})
		return
	}

	s := g.sessionByID(parts[2])
	if s == nil {
		sendJSON(response, http.StatusNotFound, map[string]string{"error": "Torrent session not found."})
		return
	}

	if len(parts) == 3 {
		switch request.Method {
		case http.MethodGet:
			sendJSON(response, http.StatusOK, g.serialize(s))
		case http.MethodDelete:
			g.mu.Lock()
			delete(g.sessions, s.id)
			g.mu.Unlock()
			s.client.Close()
			if err := os.RemoveAll(s.dataPath); err != nil {
				log.Printf("[torrent:%s] cache cleanup failed: %v", s.id, err)
			}
			sendJSON(response, http.StatusOK, map[string]string{"removed": s.id})
		default:
			sendJSON(response, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed."})
		}
		return
	}

	if len(parts) != 6 || parts[3] != "files" || (request.Method != http.MethodGet && request.Method != http.MethodHead) {
		sendJSON(response, http.StatusNotFound, map[string]string{"error": "Route not found."})
		return
	}

	file, index, err := fileByIndex(s, parts[4])
	if err != nil {
		sendJSON(response, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	switch parts[5] {
	case "stream":
		g.serveFile(request, response, s, file, index, false)
	case "download":
		g.serveFile(request, response, s, file, index, true)
	case "transcode":
		if request.Method == http.MethodHead {
			sendJSON(response, http.StatusMethodNotAllowed, map[string]string{"error": "HEAD is unavailable for converted streams."})
			return
		}
		g.transcodeFile(request, response, s, file, index)
	default:
		sendJSON(response, http.StatusNotFound, map[string]string{"error": "Route not found."})
	}
}

func (g *gateway) close() {
	g.mu.Lock()
	values := make([]*session, 0, len(g.sessions))
	for _, value := range g.sessions {
		values = append(values, value)
	}
	g.sessions = make(map[string]*session)
	g.mu.Unlock()
	for _, value := range values {
		value.client.Close()
	}
}

func main() {
	root, err := os.Getwd()
	if err != nil {
		log.Fatal(err)
	}
	g, err := newGateway(root)
	if err != nil {
		log.Fatal(err)
	}

	webRoot, err := fs.Sub(webFiles, "web")
	if err != nil {
		log.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", g.handleAPI)
	mux.HandleFunc("/api/", g.handleAPI)
	mux.Handle("/", http.FileServer(http.FS(webRoot)))

	server := &http.Server{
		Addr:              fmt.Sprintf("%s:%d", host, port),
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-signals
		log.Print("stopping Hash Harbor")
		shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownContext)
		g.close()
	}()

	log.Printf("Hash Harbor: http://%s:%d", host, port)
	log.Printf("Torrent engine: Webtor Go fork")
	log.Printf("Torrent data: %s", g.dataRoot)
	if g.ffmpegPath != "" {
		log.Printf("Media conversion: %s", g.ffmpegPath)
	} else {
		log.Printf("Media conversion: unavailable (FFmpeg not found)")
	}
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
