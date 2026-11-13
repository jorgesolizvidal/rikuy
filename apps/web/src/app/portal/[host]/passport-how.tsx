/** Until the stamps arrive (C2 · Paso 2), the passport says how it will work. */
export function PassportHowItWorks() {
  return (
    <section className="passport-how" aria-labelledby="como-funciona">
      <h2 id="como-funciona">Cómo funciona</h2>
      <ol>
        <li>Elige un circuito y visita sus lugares, en el orden que prefieras.</li>
        <li>
          En cada lugar, escanea el código del pasaporte para guardar su sello en tu teléfono. Muy
          pronto en este portal.
        </li>
        <li>Con todos los sellos del circuito, recibe el premio.</li>
      </ol>
    </section>
  );
}
