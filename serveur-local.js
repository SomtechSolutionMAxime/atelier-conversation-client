#!/usr/bin/env node
// Serveur de consultation locale de la maquette.
//
// Pourquoi il existe : GitHub Pages sert du statique — rien, chez lui, ne peut prévenir
// une page ouverte qu'une nouvelle version est arrivée. La page ne peut que redemander,
// et redemander en boucle fait clignoter l'écran et fait perdre au lecteur son défilement.
//
// Ce serveur inverse le sens : il garde un canal ouvert vers la page et lui dit
// « recharge » à la seconde où le fichier change. Tant que rien ne change,
// la page ne bouge pas du tout — aucune requête, aucun scintillement.
//
// Usage :  node serveur-local.js [port]     puis ouvrir l'adresse affichée.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ICI = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.argv[2] || 8790);
const FICHIER = path.join(ICI, 'index.html');

// Le script injecté à la volée : il ne vit QUE dans la version servie localement.
// Le fichier du dépôt reste propre — rien de tout ceci ne part sur GitHub Pages.
const CLIENT = `
<script>
(function () {
  var flux = new EventSource('/flux');
  var pastille = null;

  flux.addEventListener('recharge', function () {
    // Une pastille discrète, le temps de comprendre pourquoi la page bouge.
    if (!pastille) {
      pastille = document.createElement('div');
      pastille.textContent = 'Nouvelle version — mise à jour…';
      pastille.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:99999;'
        + 'font:12px -apple-system,system-ui,sans-serif;background:#0f172a;color:#e2e8f0;'
        + 'padding:7px 12px;border-radius:999px;box-shadow:0 2px 10px rgba(0,0,0,.25);pointer-events:none';
      document.body.appendChild(pastille);
    }
    // Conserver la position de lecture : la page revient là où le lecteur en était.
    try { sessionStorage.setItem('__defilement', String(window.scrollY)); } catch (e) {}
    setTimeout(function () { location.reload(); }, 250);
  });

  window.addEventListener('load', function () {
    try {
      var y = sessionStorage.getItem('__defilement');
      if (y !== null) { window.scrollTo(0, Number(y)); sessionStorage.removeItem('__defilement'); }
    } catch (e) {}
  });
})();
</script>
`;

const abonnes = new Set();

const serveur = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (url === '/flux') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
    });
    res.write('retry: 1000\n\n');
    abonnes.add(res);
    // Battement : garde le canal ouvert à travers les coupures silencieuses.
    const battement = setInterval(() => { try { res.write(': battement\n\n'); } catch (e) {} }, 20000);
    // Se désabonner sur la RÉPONSE, jamais sur la requête : sur un GET, le flux de requête
    // n'a pas de corps et émet 'close' aussitôt — s'y fier retirait l'abonné dans la
    // milliseconde, et le serveur n'avait alors plus personne à prévenir. Mesuré.
    res.on('close', () => { clearInterval(battement); abonnes.delete(res); });
    return;
  }

  if (url === '/' || url === '/index.html') {
    fs.readFile(FICHIER, 'utf8', (err, contenu) => {
      if (err) { res.writeHead(500); res.end('index.html illisible : ' + err.message); return; }
      const page = contenu.replace('</body>', CLIENT + '</body>');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        // Jamais de cache en local : la page servie doit toujours être le fichier du disque.
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      });
      res.end(page);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Rien ici. La maquette est à /');
});

// Surveillance du fichier.
//
// Piège mesuré, et il est silencieux : fs.watch() s'accroche à l'inode. Dès que le fichier
// est REMPLACÉ plutôt que modifié en place — ce que font git et la plupart des éditeurs —
// la surveillance meurt sans lever la moindre erreur, et le serveur se tait pour toujours
// en ayant l'air de fonctionner. C'est exactement le mode de panne à ne pas laisser passer.
//
// D'où deux surveillances au lieu d'une :
//   - fs.watch sur le RÉPERTOIRE, qui survit au remplacement du fichier (réaction immédiate) ;
//   - fs.watchFile en filet, qui compare les états et rattrape ce que la première manquerait.
// Le sondage vit ici, côté serveur : il est invisible à l'écran et ne fait rien clignoter.

let minuteur = null;
let derniere = 0;

function signaler(origine) {
  clearTimeout(minuteur);
  minuteur = setTimeout(() => {
    // Anti-rebond : une seule sauvegarde produit souvent plusieurs événements,
    // et les deux surveillances peuvent voir le même changement.
    const maintenant = Date.now();
    if (maintenant - derniere < 400) return;
    derniere = maintenant;

    const horodatage = new Date().toLocaleTimeString('fr-CA');
    console.log(`[${horodatage}] index.html a changé (${origine}) → ${abonnes.size} page(s) prévenue(s)`);
    for (const res of abonnes) {
      try { res.write('event: recharge\ndata: 1\n\n'); } catch (e) {}
    }
  }, 120);
}

fs.watch(ICI, (evenement, nom) => {
  if (nom === 'index.html') signaler('répertoire');
});

fs.watchFile(FICHIER, { interval: 500 }, (avant, apres) => {
  if (avant.mtimeMs !== apres.mtimeMs || avant.size !== apres.size) signaler('sondage');
});

serveur.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  Maquette servie en local — la page se met à jour toute seule,');
  console.log('  et seulement quand le fichier change.');
  console.log('');
  console.log(`  →  http://127.0.0.1:${PORT}/`);
  console.log('');
  console.log('  Tant que rien ne change, la page ne bouge pas. Ctrl+C pour arrêter.');
  console.log('');
});
