package main

import (
	"github.com/acme/inventory/handlers"
	"github.com/acme/inventory/store"
	"github.com/gin-gonic/gin"
)

func main() {
	s := store.NewItemStore()
	h := handlers.NewItemHandler(s)
	r := gin.Default()
	v1 := r.Group("/v1")
	v1.GET("/items/:id", h.Get)
	v1.POST("/items", h.Create)
	r.Run(":8080")
}
