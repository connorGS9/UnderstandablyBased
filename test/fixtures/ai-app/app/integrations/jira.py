from app.db import session


def sync_jira(payload: dict):
    items = payload.get("items", [])
    session.execute("INSERT INTO jira_items (data) VALUES (:d)", {"d": items})
    return len(items)
