from fastapi import APIRouter
from app.services.user_service import UserService
from app.models import User

router = APIRouter(prefix="/users", tags=["users"])
service = UserService()

@router.get("/{user_id}")
def get_user(user_id: int):
    return service.get(user_id)

@router.post("/")
def create_user(email: str):
    return service.register(email)
