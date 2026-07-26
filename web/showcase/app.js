const toast = document.querySelector(".copy-toast");
let toastTimer;

async function copyText(value) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.classList.remove("is-visible");
  }, 1800);
}

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const label = button.querySelector("span");
    const originalLabel = label?.textContent;

    try {
      await copyText(button.dataset.copy);
      if (label) label.textContent = "Copied";
      showToast("Command copied");
      window.setTimeout(() => {
        if (label) label.textContent = originalLabel;
      }, 1800);
    } catch {
      showToast("Copy failed — select the command manually");
    }
  });
});
