import express from 'express';
import fs from 'fs';
import pino from 'pino';
import {
    makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import pn from 'awesome-phonenumber';

const router = express.Router();

function removeFile(path) {
    try {
        if (fs.existsSync(path)) {
            fs.rmSync(path, { recursive: true, force: true });
        }
    } catch (e) {}
}

router.get('/', async (req, res) => {
    let num = req.query.number;

    if (!num) return res.send({ code: "Number required" });

    // Clean number
    num = num.replace(/[^0-9]/g, '');
    const phone = pn('+' + num);

    if (!phone.isValid()) {
        return res.send({ code: "Invalid number (923xxxxxxxxx)" });
    }

    num = phone.getNumber('e164').replace('+', '');
    const sessionPath = `./sessions/${num}`;

    removeFile(sessionPath);

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }))
        },
        printQRInTerminal: false,
        logger: pino({ level: "fatal" }),

        // 🔥 CRITICAL FIXES
        browser: Browsers.macOS("Safari"),
        markOnlineOnConnect: true,
        syncFullHistory: true,
        fireInitQueries: true,
        emitOwnEvents: true,
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            console.log("✅ SUCCESS CONNECTED");

            try {
                const creds = fs.readFileSync(sessionPath + '/creds.json');
                const userJid = jidNormalizedUser(num + '@s.whatsapp.net');

                await sock.sendMessage(userJid, {
                    document: creds,
                    mimetype: 'application/json',
                    fileName: 'creds.json'
                });

                await sock.sendMessage(userJid, {
                    text: "⚠️ Session file — Do NOT share"
                });

                console.log("📄 Session sent");

                await delay(2000);
                removeFile(sessionPath);

            } catch (e) {
                console.log("Send error:", e);
            }
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code !== 401) {
                console.log("🔁 Reconnecting...");
            } else {
                console.log("❌ Logged out");
            }
        }
    });

    // 🔥 PAIR GENERATE
    if (!sock.authState.creds.registered) {
        await delay(2000);

        try {
            let code = await sock.requestPairingCode(num);

            console.log("RAW:", code);

            code = code?.match(/.{1,4}/g)?.join('-') || code;

            console.log("FINAL CODE:", code);

            res.send({ code });

        } catch (err) {
            console.log("PAIR ERROR:", err);
            res.send({ code: "Pair failed" });
        }
    }
});

export default router;