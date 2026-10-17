/** Plain HTML form: works without JavaScript and posts to the same-origin logout handler. */
export function SignOutButton() {
  return (
    <form action="/logout" method="post">
      <button type="submit" className="button button-quiet">
        Cerrar sesión
      </button>
    </form>
  );
}
