CREATE TABLE products (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    description text NOT NULL,
    category text NOT NULL,
    price_cents integer NOT NULL CHECK (price_cents > 0),
    currency text NOT NULL DEFAULT 'GBP' CHECK (currency = 'GBP'),
    stock integer NOT NULL CHECK (stock >= 0),
    image_url text NOT NULL
);
CREATE TABLE orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL,
    idempotency_key uuid NOT NULL,
    total_cents integer NOT NULL CHECK (total_cents > 0),
    currency text NOT NULL DEFAULT 'GBP' CHECK (currency = 'GBP'),
    status text NOT NULL DEFAULT 'confirmed' CHECK (status = 'confirmed'),
    payment_status text NOT NULL DEFAULT 'simulated_paid' CHECK (payment_status = 'simulated_paid'),
    payment_reference text NOT NULL,
    cart_version bigint NOT NULL,
    cart_token uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (session_id, idempotency_key)
);
CREATE INDEX orders_session_created ON orders(session_id, created_at DESC);
CREATE TABLE order_items (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id uuid NOT NULL REFERENCES products(id),
    name text NOT NULL,
    quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
    unit_price_cents integer NOT NULL CHECK (unit_price_cents > 0)
);
CREATE INDEX order_items_order ON order_items(order_id);
