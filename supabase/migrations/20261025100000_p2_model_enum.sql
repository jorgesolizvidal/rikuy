-- P2 · Paso 4: 3D models (GLB) are a new kind of media. The enum value lives in its own
-- migration so it is committed before anything uses it.
alter type public.asset_purpose add value if not exists 'model';
