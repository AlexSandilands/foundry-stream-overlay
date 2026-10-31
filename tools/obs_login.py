"""
Log the OBS browser sources into Foundry as their observer users.

OBS must be started with --remote-debugging-port (see cdp_url in the config) so this
script can drive its built-in browser. Each browser source is recognised by its size,
logged in through Foundry's join screen if needed, then sent to its stream page.

All OBS browser sources share one cookie jar, so they all end up as the same Foundry
user: use one observer user for every panel. Once one panel has joined, the others
only need to load their page.

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


async def settled_state(page):
    """A game or stream page that is still loading has no user yet; give it a moment."""
    state = await page_state(page)
    for _ in range(30):
        if not state or state["user"] or not state["path"].endswith(("/game", "/stream")):
            break
        await asyncio.sleep(0.5)
        state = await page_state(page)
    return state


def on_page(state, panel):
    wanted_path, _, wanted_hash = panel["path"].partition("#")
    return (state and state["user"] == panel["user"] and state["path"].endswith(wanted_path)
            and state["hash"].lstrip("#") == wanted_hash)


async def join(page, user, password, base_url):
    """Join through Foundry's join screen. Returns "ok" or a reason it failed."""
    await page.goto(base_url + "/join", wait_until="domcontentloaded")
    if "/join" not in page.url:
        return f"Forge did not show the join screen ({page.url.split('?')[0]}); sign in to Forge first"
    await page.wait_for_selector('select[name="userid"]', state="attached", timeout=20000)
    result = await page.evaluate(JOIN_SCRIPT, [user, password])
    if result != "ok":
        return result
    try:
        await page.wait_for_url("**/game*", timeout=20000)
    except Exception:
        return "join did not complete (wrong password?)"
    return "ok"


async def log_in_all(panels, base_url, passwords):
    """
    Make every panel show its page as its user. Panels share cookies, so if any panel is
    wrong: disconnect them all (Foundry won't let a connected user join again), join once,
    then load each panel's page with the shared login.
    """
    states = [await settled_state(page) for page, _ in panels]
    if all(on_page(state, panel) for state, (_, panel) in zip(states, panels)):
        return {panel["name"]: "already logged in" for _, panel in panels}

    users = {panel["user"] for _, panel in panels}
    if len(users) != 1:
        return {panel["name"]: "all panels must use the same user (they share cookies)" for _, panel in panels}
    user = users.pop()

    for page, _ in panels:
        await page.goto(base_url + "/join", wait_until="domcontentloaded")
    await asyncio.sleep(2)  # let Foundry notice the user has disconnected

    result = await join(panels[0][0], user, passwords.get(user, ""), base_url)
    if result != "ok":
        return {panel["name"]: result for _, panel in panels}

    results = {}
    for page, panel in panels:
        await page.goto(base_url + panel["path"], wait_until="domcontentloaded")
        results[panel["name"]] = "logged in" if on_page(await settled_state(page), panel) else "page did not load as the user"
    return results


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

        found = []
        failures = 0
        for panel in config["panels"]:
            page = next((pg for pg, (w, h) in sizes.items()
                         if abs(w - panel["width"]) <= 2 and abs(h - panel["height"]) <= 2), None)
            if page is None:
                print(f"{panel['name']}: browser source not found")
                failures += 1
            else:
                found.append((page, panel))

        if found:
            results = await log_in_all(found, base_url, passwords)
            for _, panel in found:
                result = results[panel["name"]]
                failures += result not in ("logged in", "already logged in")
                print(f"{panel['name']} ({panel['user']}): {result}")
        return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
