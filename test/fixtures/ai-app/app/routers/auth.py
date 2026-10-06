from fastapi import APIRouter
from passlib.context import CryptContext
from app.db import session

router = APIRouter()
pwd = CryptContext(schemes=["bcrypt"])


def verify_password(plain: str, hashed: str) -> bool:
    return pwd.verify(plain, hashed)


def create_access_token(user_id: int) -> str:
    return f"token-{user_id}"


@router.post("/login")
async def login(email: str, password: str):
    user = session.execute("SELECT * FROM users WHERE email = :e", {"e": email})
    if not verify_password(password, user.password):
        raise ValueError("bad credentials")
    return {"token": create_access_token(user.id)}


@router.post("/register")
async def register(email: str, password: str):
    session.execute("INSERT INTO users (email, password) VALUES (:e, :p)", {"e": email, "p": pwd.hash(password)})
