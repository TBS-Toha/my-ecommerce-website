(() => {
  const message = document.getElementById("auth-message");
  const loginForm = document.getElementById("login-form");
  const registerForm = document.getElementById("register-form");

  function showMessage(text, success = false) {
    if (!message) return;
    message.textContent = text;
    message.classList.toggle("is-success", success);
  }

  function destination(user) {
    const next = new URLSearchParams(window.location.search).get("next");
    if (next?.startsWith("/") && !next.startsWith("//")) return next;
    return user.isAdmin ? "/admin.html" : "/account.html";
  }

  async function submitForm(form, endpoint, buttonLabel) {
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    button.textContent = "Please wait…";
    showMessage("");
    try {
      const fields = Object.fromEntries(new FormData(form));
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields)
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "The request could not be completed.");
      showMessage("Signed in successfully.", true);
      window.location.assign(destination(payload.user));
    } catch (error) {
      showMessage(error.message || "The request could not be completed.");
    } finally {
      button.disabled = false;
      button.textContent = buttonLabel;
    }
  }

  loginForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    submitForm(loginForm, "/api/auth/login", "Sign in");
  });

  registerForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const fields = new FormData(registerForm);
    if (fields.get("password") !== fields.get("confirmPassword")) {
      showMessage("Passwords do not match.");
      return;
    }
    submitForm(registerForm, "/api/auth/register", "Create account");
  });
})();