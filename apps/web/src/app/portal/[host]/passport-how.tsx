/** How the passport works (ADR-056, ADR-057), at the end of its pages. */
export function PassportHowItWorks() {
  return (
    <section className="passport-how" aria-labelledby="como-funciona">
      <h2 id="como-funciona">Cómo funciona</h2>
      <ol>
        <li>Elige un circuito y visita sus lugares, en el orden que prefieras.</li>
        <li>
          En cada lugar, escanea el código del pasaporte y pulsa «Sellar». Si compartes tu
          ubicación, el sello queda «con ubicación»; si no, vale igual.
        </li>
        <li>
          Los sellos se guardan en tu teléfono, sin cuenta: un sello vale para todos los circuitos
          que tienen ese lugar, y no vence.
        </li>
        <li>
          Con todos los sellos del circuito, pulsa «Pedir mi premio» en su página: recibes un
          comprobante con un código. Muéstralo donde se entrega el premio; vale 30 días y se canjea
          una sola vez.
        </li>
      </ol>
    </section>
  );
}
