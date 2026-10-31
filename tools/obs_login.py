"""
Log the OBS browser sources into Foundry as their observer users.

OBS must be started with --remote-debugging-port (see cdp_url in the config) so this
script can drive its built-in browser. Each browser source is recognised by its size,
logged in through Foundry's join screen if needed, then sent to its stream page.

Config:    ~/.config/riv-stream-overlay/obs-login.json
Passwords: ~/.config/riv-stream-overlay/passwords.json  ({"Observer1": "..."}; missing = empty)

Run:  uv run --with playwright python obs_login.py
"""

import asyncio
import json
import sys
from pathlib import Path

from playwright.async_api import async_playwright

CONFIG_DIR = Path.home() / ".config" / "riv-stream-overlay"

JOIN_SCRIPT = """
([user, password]) => {
  const select = document.querySelector('select[name="userid"]');
  if (!select) return "no join form";
  const option = [...select.options].find(o => o.textContent.trim() === user);
  if (!option) return `user ${user} not found`;
  if (option.disabled) return `user ${user} is already logged in somewhere else`;
  select.value = option.value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  const input = select.form.querySelector('input[name="password"]');
  input.value = password;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  const button = select.form.querySelector('button[name="join"]')
    ?? [...select.form.querySelectorAll("button")].find(b => /join/i.test(b.textContent));
  if (!button) return "no join button";
  button.click();
  return "ok";
}
"""


async def page_state(page):
    try:
        return await page.evaluate(
            "() => ({ width: innerWidth, height: innerHeight, path: location.pathname,"
            " hash: location.hash, user: window.game?.user?.name ?? null })"
        )
    except Exception:
        return None


async def log_in(page, panel, base_url, password):
    target = base_url + panel["path"]
    state = await page_state(page)
    wanted_path, _, wanted_hash = panel["path"].partition("#")
    if (state and state["user"] == panel["user"] and state["path"].endswith(wanted_path)
            and state["hash"].lstrip("#") == wanted_hash):
        return "already logged in"

    await page.goto(base_url + "/join", wait_until="domcontentloaded")
    if "/join" not in page.url:
        return f"Forge did not show the join screen ({page.url.split('?')[0]}); sign in to Forge first"
    await page.wait_for_selector('select[name="userid"]', state="attached", timeout=20000)
    result = await page.evaluate(JOIN_SCRIPT, [panel["user"], password])
    if result != "ok":
        return result
    try:
        await page.wait_for_url("**/game*", timeout=20000)
    except Exception:
        return "join did not complete (wrong password?)"
    if panel["path"] != "/game":
        await page.goto(target, wait_until="domcontentloaded")
    return "logged in"


async def main():
    config = json.loads((CONFIG_DIR / "obs-login.json").read_text())
    passwords_file = CONFIG_DIR / "passwords.json"
    passwords = json.loads(passwords_file.read_text()) if passwords_file.exists() else {}
    base_url = config["base_url"].rstrip("/")
    host = base_url.split("//", 1)[1]

    async with async_playwright() as p:
        try:
            browser = await p.chromium.connect_over_cdp(config["cdp_url"])
        except Exception:
            print("Could not reach OBS. Start OBS with --remote-debugging-port=9222.")
            return 1
        pages = [page for context in browser.contexts for page in context.pages if host in page.url
                 or "forge-vtt.com" in page.url]
        sizes = {}
        for page in pages:
            state = await page_state(page)
            if state:
                sizes[page] = (state["width"], state["height"])

        failures = 0
        for panel in config["panels"]:
            page = next((pg for pg, (w, h) in sizes.items()
                         if abs(w - panel["width"]) <= 2 and abs(h - panel["height"]) <= 2), None)
            if page is None:
                print(f"{panel['name']}: browser source not found")
                failures += 1
                continue
            result = await log_in(page, panel, base_url, passwords.get(panel["user"], ""))
            ok = result in ("logged in", "already logged in")
            failures += not ok
            print(f"{panel['name']} ({panel['user']}): {result}")
        return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
