-- Apply together with the app release that uses place_orders_v2.
-- The old checkout added fixed delivery fees (boda 150, truck 600); it is no longer available to the app.
revoke execute on function public.place_orders(jsonb, text, text, text) from authenticated;
