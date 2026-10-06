from sqlmodel import Session, select
from app.models import User
from app.db import engine


class UserService:
    def get(self, user_id: int) -> User | None:
        with Session(engine) as session:
            return session.exec(select(User).where(User.id == user_id)).first()

    def register(self, email: str) -> User:
        user = User(email=email)
        self._validate(user)
        with Session(engine) as session:
            session.add(user)
            session.commit()
        return user

    def _validate(self, user: User) -> None:
        if "@" not in user.email:
            raise ValueError("bad email")
