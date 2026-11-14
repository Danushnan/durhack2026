import asyncio
import os
from uuid import UUID, NAMESPACE_URL, uuid5
from fastapi import Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from services.common.runtime import internal, make_app

app = make_app("payment-api")


class Payment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: UUID
    idempotency_key: UUID
    amount_cents: int = Field(strict=True, gt=0, le=100_000_000)
    currency: str = Field(pattern="^GBP$")


@app.post("/payments", dependencies=[Depends(internal)])
async def pay(body: Payment):
    await asyncio.sleep(max(0, min(float(os.getenv("PAYMENT_DELAY_MS", "100")), 8000)) / 1000)
    if os.getenv("PAYMENT_FAIL", "false").lower() == "true":
        raise HTTPException(402, "Simulated payment declined. No money was taken.")
    # A deterministic mock reference survives restarts; this provider never charges money.
    reference = uuid5(NAMESPACE_URL, f"minishop:{body.session_id}:{body.idempotency_key}:{body.amount_cents}:{body.currency}")
    return {"status": "simulated_paid", "transaction_id": f"sim_{reference}", "simulated": True}
