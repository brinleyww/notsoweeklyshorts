// The account API on the proxy (names, clips, clip links). An account is the profile's
// private token; the proxy only keeps its hash.
(function () {
    const API = window.__nswsApiBase;
    const TOKEN = /^[0-9a-f]{64}$/;
    const UNCLAIMED_KEY = "_nswsNameUnclaimed";
    const NAME_TAKEN = "This username is already taken. Please pick another one.";
    const NAME_BLOCKED = "That username isn't allowed. Please pick another one.";
    // Whether the last name refused was refused by the slur filter rather than for being taken.
    let lastBlocked = false;

    function profileToken() {
        const token = window.__nswsProfileToken?.();
        return TOKEN.test(token || "") ? token : null;
    }

    // Rejects with err.status (0 when the proxy couldn't be reached).
    async function call(path, body) {
        let response;
        try {
            response = await fetch(API + "nsws/" + path, {
                method: "POST",
                headers: { "Content-Type": "text/plain" },
                body: JSON.stringify(body),
            });
        } catch {
            throw Object.assign(new Error("Clip server unreachable"), { status: 0 });
        }
        if (!response.ok) throw Object.assign(new Error("Clip server answered " + response.status), { status: response.status });
        return response.json();
    }

    // true or false, or null when it couldn't be checked.
    async function nameAvailable(token, nickname, claim) {
        if (!API || !TOKEN.test(token || "")) return null;
        try {
            const answer = await call(claim ? "names/claim" : "names/check", { userToken: token, nickname });
            lastBlocked = answer.blocked === true;
            return answer.available === true;
        } catch {
            return null;
        }
    }

    function showNameTaken(onOk, blocked) {
        const text = blocked ?? lastBlocked ? NAME_BLOCKED : NAME_TAKEN;
        const box = window.__nswsMessageBox;
        if (box && !box.isOpen) box.show(text, "Ok", onOk || null);
        else alert(text);
    }

    function markUnclaimed(token) {
        try {
            localStorage.setItem(UNCLAIMED_KEY, token);
        } catch {}
    }

    function clearUnclaimed() {
        try {
            localStorage.removeItem(UNCLAIMED_KEY);
        } catch {}
    }

    // A new profile's random name is reserved for it, rolling a new one while it's taken.
    // Until the proxy answers, the profile keeps the name it was given and this is retried
    // on the next visit.
    let claiming = null;
    async function claimGeneratedName(profiles, slot) {
        const profile = profiles.getUserProfile(slot);
        if (!profile || !TOKEN.test(profile.token || "")) return;
        markUnclaimed(profile.token);
        let nickname = profile.nickname;
        for (let attempt = 0; attempt < 20; attempt++) {
            const available = await nameAvailable(profile.token, nickname, true);
            if (available == null) return;
            const current = profiles.getUserProfile(slot);
            if (current?.token !== profile.token) return;
            if (available) {
                if (current.nickname !== nickname) profiles.setNickname(nickname, slot);
                clearUnclaimed();
                return;
            }
            // The player renamed themselves meanwhile; the profile screen checks that name.
            if (current.nickname !== profile.nickname) {
                clearUnclaimed();
                return;
            }
            nickname = window.__nswsGenerateName();
        }
    }

    window.__nswsAccounts = {
        call,
        profileToken,
        nameAvailable,
        showNameTaken,
        claimGeneratedName(profiles, slot) {
            claiming = (claiming || Promise.resolve()).then(() => claimGeneratedName(profiles, slot)).catch(() => {});
            return claiming;
        },
        retryGeneratedName(profiles) {
            let pending = null;
            try {
                pending = localStorage.getItem(UNCLAIMED_KEY);
            } catch {}
            const slot = profiles.profileSlot;
            if (pending && profiles.getUserProfile(slot)?.token === pending) this.claimGeneratedName(profiles, slot);
        },
    };
})();
