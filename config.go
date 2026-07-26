package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
)

const defaultPort = 3210

type appConfig struct {
	Port int `json:"port"`
}

type configStore struct {
	mu   sync.RWMutex
	path string
	data appConfig
}

func defaultConfigDir() (string, error) {
	if override := os.Getenv("HASH_HARBOR_CONFIG_DIR"); override != "" {
		return filepath.Abs(override)
	}
	root, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("locate user configuration directory: %w", err)
	}
	return filepath.Join(root, "Hash Harbor"), nil
}

func loadConfig(directory string) (*configStore, error) {
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return nil, fmt.Errorf("create configuration directory: %w", err)
	}
	store := &configStore{
		path: filepath.Join(directory, "config.json"),
		data: appConfig{Port: defaultPort},
	}
	body, err := os.ReadFile(store.path)
	if errors.Is(err, os.ErrNotExist) {
		if err := store.save(store.data); err != nil {
			return nil, err
		}
		return store, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read configuration: %w", err)
	}
	if err := json.Unmarshal(body, &store.data); err != nil {
		return nil, fmt.Errorf("parse configuration: %w", err)
	}
	if err := validatePort(store.data.Port); err != nil {
		return nil, fmt.Errorf("configuration: %w", err)
	}
	return store, nil
}

func validatePort(port int) error {
	if port < 1024 || port > 65535 {
		return errors.New("port must be between 1024 and 65535")
	}
	return nil
}

func (store *configStore) current() appConfig {
	store.mu.RLock()
	defer store.mu.RUnlock()
	return store.data
}

func (store *configStore) save(value appConfig) error {
	if err := validatePort(value.Port); err != nil {
		return err
	}
	body, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return fmt.Errorf("encode configuration: %w", err)
	}
	body = append(body, '\n')
	temp, err := os.CreateTemp(filepath.Dir(store.path), "config-*.json.tmp")
	if err != nil {
		return fmt.Errorf("create temporary configuration: %w", err)
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return fmt.Errorf("secure temporary configuration: %w", err)
	}
	if _, err := temp.Write(body); err != nil {
		_ = temp.Close()
		return fmt.Errorf("write configuration: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close configuration: %w", err)
	}
	if err := os.Rename(tempName, store.path); err != nil {
		return fmt.Errorf("replace configuration: %w", err)
	}
	store.mu.Lock()
	store.data = value
	store.mu.Unlock()
	return nil
}

func checkPortAvailable(port int) error {
	listener, err := net.Listen("tcp", fmt.Sprintf("%s:%d", host, port))
	if err != nil {
		return fmt.Errorf("localhost port %d is already in use", port)
	}
	return listener.Close()
}
