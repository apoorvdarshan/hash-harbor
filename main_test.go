package main

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNormalizeHexHash(t *testing.T) {
	const hash = "08ada5a7a6183aae1e09d831df6748d566095a10"
	source, id, err := normalizeSource(hash)
	if err != nil {
		t.Fatal(err)
	}
	if source != "magnet:?xt=urn:btih:"+hash || id != hash {
		t.Fatalf("unexpected normalized value: %q %q", source, id)
	}
}

func TestNormalizeUppercaseHexHash(t *testing.T) {
	const hash = "28EBD2BCA487E1EA0AC95E8BEA5BB44FFF2CAC42"
	_, id, err := normalizeSource(hash)
	if err != nil {
		t.Fatal(err)
	}
	if id != strings.ToLower(hash) {
		t.Fatalf("expected lowercase id, got %q", id)
	}
}

func TestNormalizeRejectsInvalidValue(t *testing.T) {
	if _, _, err := normalizeSource("not-a-torrent"); err == nil {
		t.Fatal("expected invalid source error")
	}
}

func TestConfigPersistsPort(t *testing.T) {
	store, err := loadConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if actual := store.current().Port; actual != defaultPort {
		t.Fatalf("expected default port %d, got %d", defaultPort, actual)
	}
	if err := store.save(appConfig{Port: 43210}); err != nil {
		t.Fatal(err)
	}
	reloaded, err := loadConfig(filepath.Dir(store.path))
	if err != nil {
		t.Fatal(err)
	}
	if actual := reloaded.current().Port; actual != 43210 {
		t.Fatalf("expected persisted port 43210, got %d", actual)
	}
}

func TestSettingsChangePersistsAndRequestsRestart(t *testing.T) {
	configDirectory := t.TempDir()
	store, err := loadConfig(configDirectory)
	if err != nil {
		t.Fatal(err)
	}
	g, err := newGateway(t.TempDir(), store)
	if err != nil {
		t.Fatal(err)
	}
	defer g.close()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}

	body := strings.NewReader(fmt.Sprintf(`{"port":%d}`, port))
	request := httptest.NewRequest(http.MethodPut, "/api/settings", body)
	response := httptest.NewRecorder()
	g.handleAPI(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", response.Code, response.Body.String())
	}
	if actual := store.current().Port; actual != port {
		t.Fatalf("expected saved port %d, got %d", port, actual)
	}
	select {
	case <-g.restart:
	case <-time.After(time.Second):
		t.Fatal("expected restart request")
	}
}

func TestContentType(t *testing.T) {
	tests := map[string]string{
		"movie.mkv": "video/x-matroska",
		"movie.mp4": "video/mp4",
		"audio.mp3": "audio/mpeg",
	}
	for name, expected := range tests {
		if actual := contentType(name); actual != expected {
			t.Errorf("%s: expected %q, got %q", name, expected, actual)
		}
	}
}
