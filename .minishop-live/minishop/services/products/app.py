from uuid import UUID
from fastapi import HTTPException
from services.common.runtime import db_target, make_app, measured

app = make_app("product-api", database=True)
COLUMNS = "id, name, description, category, price_cents, currency, stock, image_url"


@app.get("/products")
async def products():
    async with measured("product-api", db_target(), "products.select"):
        async with app.state.db.connection() as conn:
            return await (await conn.execute(f"SELECT {COLUMNS} FROM products ORDER BY name")).fetchall()


@app.get("/products/{product_id}")
async def product(product_id: UUID):
    async with measured("product-api", db_target(), "products.select_one"):
        async with app.state.db.connection() as conn:
            row = await (await conn.execute(f"SELECT {COLUMNS} FROM products WHERE id=%s", (product_id,))).fetchone()
    if not row:
        raise HTTPException(404, "Product not found")
    return row
