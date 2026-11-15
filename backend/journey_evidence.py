"""Small evidence helpers shared by the two reviewed MiniShop journey types."""
import re


def public(row):
    data = row.as_dict()
    data['route'] = re.sub(r'[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}', '{id}', row.route or '') or None
    return data


def successful(rows):
    return bool(rows) and all(200 <= r.status < 300 and not r.error and r.outcome in (None, 'completed') for r in rows)


def step(key, description, evidence, collecting, ambiguous, source=None, target=None, basis='backend', focus=None):
    available = bool(evidence) and not ambiguous
    return dict(key=key, description=description if available else 'Observation unavailable for this stage.',
                state=('observed' if successful(evidence) else 'failed') if available else ('pending' if collecting and not ambiguous else 'unavailable'),
                event_ids=[r.event_id for r in evidence] if not ambiguous else [], basis=basis,
                from_service=source if available else None, to_service=target if available else None,
                focus_service=focus if available else None)
