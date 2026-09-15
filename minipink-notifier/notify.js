// Script di notifica per MiniPink.
// Legge i dati da Firestore, controlla cosa è cambiato dall'ultima volta,
// e manda le notifiche push a tutti i telefoni registrati tramite Firebase
// Cloud Messaging. Pensato per essere lanciato da GitHub Actions ogni
// pochi minuti, gratis, senza bisogno del piano Firebase a pagamento:
// l'invio di notifiche FCM è gratuito, quello che costava era far girare
// le Cloud Functions — qui non ce ne sono, gira tutto qui dentro.

const admin = require("firebase-admin");

// Ora (fuso Italia) a partire dalla quale possono partire i promemoria giornalieri
// (allenamento in giornata, partita in arrivo). Cambia questo numero se vuoi un altro orario.
const ORA_MINIMA_PROMEMORIA = 8;

function oraAttualeRoma() {
  return Number(new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", hour12: false }).format(new Date()));
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

function oggiISO() {
  return new Date().toISOString().slice(0, 10);
}

async function leggiValore(nomeDoc, fallback) {
  const snap = await db.collection("app").doc(nomeDoc).get();
  return snap.exists && snap.data().value !== undefined ? snap.data().value : fallback;
}

async function inviaATutti(titolo, corpo) {
  const tokensSnap = await db.collection("tokens").get();
  const tokens = tokensSnap.docs.map((d) => d.id);
  if (tokens.length === 0) {
    console.log("Nessun dispositivo registrato, nessuna notifica inviata.");
    return;
  }
  const risultato = await admin.messaging().sendEachForMulticast({
    notification: { title: titolo, body: corpo },
    tokens,
  });
  console.log(`Inviate a ${risultato.successCount}/${tokens.length} dispositivi ("${titolo}")`);
}

async function main() {
  const oggi = oggiISO();

  const [partite, allenamenti, squadre, notificaManuale, stato] = await Promise.all([
    leggiValore("partite", []),
    leggiValore("allenamenti", []),
    leggiValore("squadre", {}),
    leggiValore("notificaManuale", null),
    db.collection("app").doc("notificheStato").get().then((s) => (s.exists ? s.data() : {})),
  ]);

  const nuovoStato = {
    convocazioniConteggio: { ...(stato.convocazioniConteggio || {}) },
    allenamentiNotificati: [...(stato.allenamentiNotificati || [])],
    ultimoGiornoAllenamentoOggi: stato.ultimoGiornoAllenamentoOggi || {},
    ultimoGiornoPromemoria: stato.ultimoGiornoPromemoria || null,
    ultimaNotificaManuale: stato.ultimaNotificaManuale || 0,
  };

  // 1) Nuove convocazioni per partita
  for (const p of partite) {
    const n = (p.convocazioni || []).length;
    const prima = nuovoStato.convocazioniConteggio[p.id] || 0;
    if (n > prima) {
      const casa = (squadre[p.casa] || {}).nome || p.casa;
      const ospite = (squadre[p.ospite] || {}).nome || p.ospite;
      await inviaATutti("Nuove convocazioni 📋", `Convocazioni per ${casa} vs ${ospite} del ${p.data}. Apri l'app per confermare la presenza.`);
    }
    nuovoStato.convocazioniConteggio[p.id] = n;
  }

  // 2) Nuovo allenamento creato
  for (const a of allenamenti) {
    if (!nuovoStato.allenamentiNotificati.includes(a.id)) {
      await inviaATutti("Nuovo allenamento 🏀", `Allenamento il ${a.data} alle ${a.ora}${a.luogo ? " — " + a.luogo : ""}. Apri l'app per confermare la presenza.`);
      nuovoStato.allenamentiNotificati.push(a.id);
    }
  }

  // 3) Allenamento oggi (una volta al giorno per allenamento, solo dopo l'orario minimo)
  if (oraAttualeRoma() >= ORA_MINIMA_PROMEMORIA) {
    for (const a of allenamenti) {
      if (a.data === oggi && nuovoStato.ultimoGiornoAllenamentoOggi[a.id] !== oggi) {
        await inviaATutti("Allenamento oggi 🏀", `Allenamento oggi alle ${a.ora}${a.luogo ? " — " + a.luogo : ""}. Apri l'app e conferma la presenza.`);
        nuovoStato.ultimoGiornoAllenamentoOggi[a.id] = oggi;
      }
    }
  }

  // 4) Promemoria settimanale (una volta al giorno, solo dopo l'orario minimo, se c'è una partita nei prossimi 7 giorni)
  if (nuovoStato.ultimoGiornoPromemoria !== oggi && oraAttualeRoma() >= ORA_MINIMA_PROMEMORIA) {
    const oggiData = new Date(oggi + "T00:00:00");
    const tra7 = new Date(oggiData.getTime() + 7 * 24 * 60 * 60 * 1000);
    const prossima = partite
      .filter((p) => { const d = new Date(p.data + "T00:00:00"); return d >= oggiData && d <= tra7; })
      .sort((a, b) => new Date(a.data) - new Date(b.data))[0];
    if (prossima) {
      const casa = (squadre[prossima.casa] || {}).nome || prossima.casa;
      const ospite = (squadre[prossima.ospite] || {}).nome || prossima.ospite;
      await inviaATutti("Partita in arrivo 🏀", `${casa} vs ${ospite} — ${prossima.data} alle ${prossima.ora}, ${prossima.palazzetto || ""}`);
    }
    nuovoStato.ultimoGiornoPromemoria = oggi;
  }

  // 5) Notifica manuale inviata dall'admin dalle Impostazioni dell'app
  if (notificaManuale && notificaManuale.inviata && notificaManuale.inviata > nuovoStato.ultimaNotificaManuale) {
    await inviaATutti(notificaManuale.titolo, notificaManuale.corpo || "");
    nuovoStato.ultimaNotificaManuale = notificaManuale.inviata;
  }

  await db.collection("app").doc("notificheStato").set(nuovoStato);
  console.log("Controllo completato.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
