package store

import "database/sql"

type ItemStore struct {
	db *sql.DB
}

func NewItemStore() *ItemStore {
	return &ItemStore{}
}

func (s *ItemStore) Find(id string) (string, error) {
	var name string
	err := s.db.QueryRow("SELECT name FROM items WHERE id = $1", id).Scan(&name)
	return name, err
}

func (s *ItemStore) Insert(name string) error {
	_, err := s.db.Exec("INSERT INTO items (name) VALUES ($1)", name)
	return err
}
