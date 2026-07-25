package main

import "testing"

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

func TestNormalizeRejectsInvalidValue(t *testing.T) {
	if _, _, err := normalizeSource("not-a-torrent"); err == nil {
		t.Fatal("expected invalid source error")
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
