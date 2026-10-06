from fastapi import FastAPI
from app.api import users
from app.config import settings

app = FastAPI()
app.include_router(users.router, prefix=settings.API_PREFIX)
