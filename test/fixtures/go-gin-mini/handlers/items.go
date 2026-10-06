package handlers

import (
	"github.com/acme/inventory/store"
	"github.com/gin-gonic/gin"
)

type ItemHandler struct {
	store *store.ItemStore
}

func NewItemHandler(s *store.ItemStore) *ItemHandler {
	return &ItemHandler{store: s}
}

func (h *ItemHandler) Get(c *gin.Context) {
	item, _ := h.store.Find(c.Param("id"))
	c.JSON(200, item)
}

func (h *ItemHandler) Create(c *gin.Context) {
	h.store.Insert(c.PostForm("name"))
	c.Status(201)
}
