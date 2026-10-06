from fastapi import FastAPI
from app.routers import tools, chat, auth, notes, integrations

app = FastAPI()
app.include_router(tools.router, prefix="/tools")
app.include_router(chat.router, prefix="/chat")
app.include_router(auth.router, prefix="/auth")
app.include_router(notes.router, prefix="/notes")
app.include_router(integrations.router, prefix="/integrations")
