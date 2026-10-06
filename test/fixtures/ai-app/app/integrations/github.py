from app.db import session


def sync_github(payload: dict):
    items = payload.get("items", [])
    session.execute("INSERT INTO github_items (data) VALUES (:d)", {"d": items})
    return len(items)
