# Wav Fake Cleaner V2

Nettoie automatiquement les faux followers de ton compte Threads.

---

## Comment ca marche ?

1. L'app recupere ta liste de followers
2. Elle analyse chaque profil avec un algorithme en 7 etapes
3. Les comptes detectes comme fake sont automatiquement supprimes
4. Tu suis tout en temps reel depuis un dashboard web

---

## Installation (5 minutes)

### Ce qu'il te faut

- **Python 3.11+** : [python.org/downloads](https://www.python.org/downloads/)
  > IMPORTANT : Coche "Add Python to PATH" pendant l'installation
- **Node.js 18+** : [nodejs.org](https://nodejs.org/) (prends la version LTS)

### Windows

```
1. Double-clique sur setup.bat
2. Attends que tout s'installe
3. C'est pret !
```

### Mac / Linux

```bash
chmod +x setup.sh start.sh
./setup.sh
```

---

## Utilisation

### Etape 1 : Se connecter a Threads (une seule fois)

```
python login.py
```

Un navigateur s'ouvre. Connecte-toi a ton compte Threads, puis reviens dans le terminal et appuie sur Entree. Ta session est sauvegardee, tu n'auras pas besoin de le refaire.

### Etape 2 : Lancer l'application

**Windows :** double-clique sur `start.bat`
**Mac/Linux :** `./start.sh`

Ouvre ton navigateur sur **http://localhost:8000**

### Etape 3 : Utiliser le dashboard

Le dashboard affiche :
- **5 compteurs** : total followers, en attente, scannes, faux, supprimes
- **4 boutons** :
  - **Recuperer** : charge la liste de tes followers
  - **Scanner** : analyse les profils un par un
  - **Nettoyer** : supprime les faux followers
  - **Autopilote** : fait tout automatiquement (recommande)
- **Logs en direct** : tu vois exactement ce que fait l'app
- **Tableau** : liste de tous les followers avec leur score

### Le bouton "Parametres" permet de :
- Changer ton nom d'utilisateur Threads
- Ajuster le seuil de detection (defaut: 70/100)
- Choisir le profil de securite (prudent / normal / agressif)

---

## Comment fonctionne la detection ?

Chaque profil commence a 0 et accumule des points. Au-dessus du seuil (70 par defaut), il est considere comme fake.

| Signal | Points | Pourquoi |
|--------|--------|----------|
| 0 followers | +15 | Suspect |
| 0 posts | +35 | Tres suspect |
| Posts tous recents (<72h) | +20 | Spam |
| Posts dupliques (>50%) | +40 | Spambot |
| Mots spam (WhatsApp, Telegram...) | +25 | Arnaque |
| 0 reponses | +25 | Pas d'interaction |
| 0 posts ET 0 reponses | +20 | Combo suspect |
| Pas de bio | +15 | Pas d'effort |
| Compte prive + peu de followers | +40 | Fake typique |
| --- | --- | --- |
| A une bio | -10 | Bon signe |
| 500+ followers | -10 | Probablement reel |
| A des posts + des reponses | -15 | Actif |
| A un vrai nom | -5 | Bon signe |

**Exemples :**
- Bot typique (0 followers, 0 posts, 0 reponses, pas de bio) = **100/100**
- Compte legit (200 followers, 10 posts, bio, nom) = **0/100**

---

## Profils de securite

| Profil | Suppressions/jour | Suppressions/heure | Vitesse |
|--------|------------------|--------------------|---------|
| Prudent | 160 | 25 | Lent mais tres safe |
| Normal | 300 | 40 | Equilibre (recommande) |
| Agressif | 500 | 50 | Rapide mais plus de risque |

L'app simule un comportement humain (pauses aleatoires, delais variables) pour eviter d'etre bloquee par Threads.

---

## En cas de probleme

| Probleme | Solution |
|----------|----------|
| "Python non trouve" | Reinstalle Python et coche "Add to PATH" |
| "Node.js non trouve" | Installe Node.js depuis nodejs.org |
| Erreur 429 | L'app se met en pause automatiquement. Attends. |
| Session expiree | Relance `python login.py` |
| Le dashboard ne charge pas | Verifie que le backend tourne (terminal) |

---

## Structure du projet

```
wav-fake-cleaner-v2/
├── backend/           # Serveur Python (FastAPI)
│   ├── engine/        # Moteur : fetcher, scorer, cleaner
│   ├── api/           # Endpoints REST + WebSocket
│   └── database/      # Base de donnees SQLite
├── frontend/          # Interface web (React + Tailwind)
├── data/              # Session Threads + base de donnees
├── setup.bat/.sh      # Installation automatique
├── start.bat/.sh      # Lancement one-click
└── login.py           # Connexion a Threads
```

## API (pour les developpeurs)

| Methode | URL | Description |
|---------|-----|-------------|
| GET | /api/stats | Stats du dashboard |
| GET | /api/followers | Liste des followers |
| POST | /api/fetch | Lancer la recuperation |
| POST | /api/scan | Lancer le scan |
| POST | /api/clean | Lancer le nettoyage |
| POST | /api/autopilot | Tout automatique |
| POST | /api/stop | Arreter |
| GET | /api/logs | Historique des actions |
| WS | /ws/logs | Logs temps reel |

Documentation interactive : **http://localhost:8000/docs**
