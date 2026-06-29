# UA-MIS Org Capstone Stacks — Survey for Scaffolder Starter Templates

**Research scope:** Survey the UA-MIS GitHub org's *actual* student/capstone repos to determine what stacks teams really deploy, so the IDP scaffolder can ship starter templates that match reality. Read-only; no changes made.

**Method:** Enumerated all ~140 org repos via `gh repo list`. Excluded GitHub-Classroom exam/assignment repos (`exam2-pt3-*`, `exam-2-part-2-*`, `pa4/pa5-*`, `MVCPractice`, `ICA1`) and platform/test repos (`platform-infra`, `v1check`, `v1verify`, `sample-app`). Sampled ~44 genuine capstone repos (weighted toward 2024–2026 = current practice). For each: `gh api .../languages`, root + recursive `git/trees`, and decoded manifest contents (`package.json` deps, `requirements.txt`, `*.csproj`, `composer.json`).

**Confidence:** HIGH for the dominant patterns (large sample, manifests read directly). MEDIUM for a handful of repos whose code lives in git submodules or unconventional subdirs (noted inline).

---

## Executive summary

- **Three language families dominate:** (1) **React/Node TypeScript-or-JS** full-stack web, (2) **C# ASP.NET Core Web API** backends, (3) **Python** (Flask / FastAPI) APIs and data/ML scripts. A fourth recurring shape is **React Native / Expo mobile** apps.
- **MySQL is the de-facto org database across *every* language.** Node apps use `mysql2`; the C# teams use `Pomelo.EntityFrameworkCore.MySql` (not SQL Server); the Flask team uses `mysql-connector-python`. A managed MySQL offering would serve the majority of teams. Secondary: Prisma ORM (DB-agnostic, usually pointed at MySQL/Postgres), plus cloud-managed Firebase and GCP BigQuery on a few teams.
- **Most teams ship NO Dockerfile.** Only ~4 of 44 sampled repos contained one (`UA-MIS-S26`, `ida-dataset-search`, `InsitelyV4Strapi`, `Bio-ISAC-S26`). This is the single biggest gap between "what students push" and "what the platform needs to build an image." It strongly motivates both (a) a **provided/generated Dockerfile per template** and (b) a **VM/buildpack-style workload option** for teams that never containerize.
- **Multi-component (separate FE + BE) is common** — split either into sibling folders (`frontend/`+`backend/`, `app/`+`server/`, `client/`+`api/`) or, increasingly, separate repos (`AISCapstoneWeb`/`AISserver`/`AISCapstoneApp`; `DaVita-LSP-Frontend-S24`/`-Backend-S24`; `ooc-admin`/`ooc-student`/`ooc-api`). The scaffolder needs a first-class **multi-component template**, not just single-service.
- Strong **toolchain conventions** worth baking in: **Vite** (React SPA), **Next.js** (full-stack React), **Clerk** (auth — appears in 5+ recent repos), **Prisma**, **Tailwind/daisyUI**, **Expo** (mobile).

---

## 1. Repo → stack table (sampled)

| Repo | Year | Primary lang(s) | Framework(s) | Shape | DB | Containerized? |
|---|---|---|---|---|---|---|
| accounting-manager | 2026 | TypeScript | **Next.js** + Prisma, Clerk, Tailwind/daisyUI, Vitest | Full-stack (Next monolith) | Prisma (MySQL/PG) | No |
| UAMIS-LabMx | 2026 | TypeScript | (bmad-swarm scaffolded; src/ app) | Web app | — | No |
| UA-Museums-S26 | 2026 | (submodules) | Frontend + ETL (git submodules) | Multi-repo (FE+ETL) | — | (n/a) |
| VOCAL-S26 | 2026 | JavaScript | **Vite** + **Capacitor** (iOS/Android), Leaflet | FE / hybrid-mobile | Firebase | No |
| Bio-ISAC-S26 | 2026 | C# + JS | **ASP.NET Core** (Slack-Back-End) + **React** (ticketing-system) | Full-stack, 2 components | (appsettings) | **Yes** (Dockerfile + nginx, GCP Cloud Run) |
| DaVita-S26 | 2026 | TypeScript | **React + Vite** FE + **Express** API (concurrently), Swagger | Full-stack (1 repo) | **mysql2** | docker-compose |
| UA-MIS-S26 | 2026 | Python/HTML | **Flask** (+ gunicorn, flask-cors, ONNX embeddings) | API + static | **MySQL** (mysql-connector) | **Yes** (Dockerfile) |
| ida-dataset-search | 2026 | TypeScript | **Next.js** + Prisma, Clerk | Full-stack (Next) | **mysql2 + pg** | **Yes** (Dockerfile + compose) |
| uainnovate | 2026 | CSS/PHP | **composer** (PHP) + JS assets | Static/CMS site | — | No |
| MISHUB2.0 | 2025 | TypeScript | **Next.js** (apps/ monorepo), MSAL auth | Full-stack (Next) | MySQL (migration.sql) | No |
| MyVoice-F25 | 2025 | Python | (gradle present; Python primary) | API/data | — | No |
| MyVoice-F25-DB | 2025 | Python | Node backend/ + Python | API + DB tooling | — | No |
| SolarChauffeur-S25 | 2025 | JS/HTML | **Expo / React Native**, Firebase, Leaflet | Mobile | Firebase | No |
| GameDay-Web-Portal | 2025 | JavaScript | **AWS Amplify** + webpack, xlsx/papaparse | FE (Amplify-hosted) | Amplify/AWS | No |
| Game-Day-App | 2025 | JavaScript | **Expo / React Native**, axios | Mobile | (API) | No |
| standd | 2025 | TypeScript | **Next.js** + Prisma, Clerk, Radix UI, BullMQ/ioredis | Full-stack (Next) | **mysql2** (+ Redis) | No |
| standd-file-upload-api | 2025 | TypeScript | **Next.js** API, mysql2 | API | **mysql2** | No |
| AISserver | 2025 | JavaScript/TS | **Express** + Prisma, Clerk, node-cron, Expo push | API (own repo) | Prisma (MySQL) | No |
| AISCapstoneWeb | 2025 | TypeScript | React (admin web) | FE (own repo) | (via API) | No |
| AISCapstoneApp | 2025 | TypeScript | **Expo / React Native** | Mobile (own repo) | (via API) | No |
| AAC-S25 | 2025 | Python | **React Native** front + Python | Mobile + Python | — | No |
| AAC-S25-DB | 2025 | Python | Node backend/ + Python | API + DB | — | No |
| ua-baseball-spring-2025 | 2025 | C# | **ASP.NET Core** (.NET) | API | (appsettings) | No |
| InsitelyV4Strapi | 2025 | TypeScript | **Strapi v4** (headless CMS) + React | CMS/full-stack | better-sqlite3 | **Yes** (Dockerfile) |
| ooc-api | 2025 | C# | **ASP.NET Core** .NET 7 + **EF Core** | API (own repo) | **MySQL** (Pomelo EF) | No |
| ooc-admin | 2024 | TypeScript | **React + Vite** + Tailwind | FE (own repo) | (via API) | No |
| ooc-student | 2024 | TypeScript | **React + Vite** + Tailwind | FE (own repo) | (via API) | No |
| SolarChauffeurF24 | 2024 | JavaScript | **Expo/RN** front + **Express** backend | Mobile + API (1 repo) | **mysql2** | No |
| DavitaDev | 2024 | TypeScript | (davitaapp/ subdir) React | FE | — | No |
| Davitabackend | 2024 | Python | **FastAPI** + uvicorn, CatBoost, BigQuery | API/ML | **GCP BigQuery** | No |
| UAMISHUB | 2024 | C# | **ASP.NET Core** api/ + web | Full-stack (1 repo) | (appsettings) | No |
| User-Portal | 2024 | JS + C# | React front + C# backend | Full-stack | — | No |
| 5-Spot | 2024 | JavaScript | **Expo / React Native**, Formik | Mobile | mysql | No |
| ida-content-manager | 2024 | TypeScript | **React** (CRA), axios | FE | (via API) | No |
| ida-search | 2024 | TypeScript | **React**, axios | FE | (via API) | No |
| ida_api | 2024 | C# | **ASP.NET Core** .NET 7 + **EF Core** | API | **MySQL** (Pomelo EF) | No |
| Mentorship-App | 2024 | C#/JS | ASP.NET + JS front | Full-stack | — | No |
| DaVita-LSP-Frontend-S24 | 2024 | TypeScript | React (davita-frontend/) | FE (own repo) | (via API) | No |
| DaVita-LSP-Backend-S24 | 2024 | C# | **ASP.NET Core** + EF | API (own repo) | (appsettings) | No |
| catboosthealthAI | 2024 | Python | ML scripts (CatBoost) | Batch/ML | CSV/BigQuery | No |

*("via API" = front-end whose persistence lives in a sibling backend/repo. "appsettings" = C# connection string present; the two C# csproj read directly both used Pomelo MySQL, so MySQL is the safe assumption for the family.)*

---

## 2. Common patterns (what recurs)

1. **React everywhere on the front end.** Nearly every web FE is React — split roughly between **Vite SPAs** (ooc-admin/student, DaVita-S26, VOCAL via Capacitor) and **Next.js full-stack monoliths** (accounting-manager, standd, ida-dataset-search, MISHUB2.0). Create-React-App lingers in older repos (ida-search, ida-content-manager).
2. **Next.js is the rising full-stack default (2025–2026).** Multiple recent teams ship a single Next.js app (FE + API routes + Prisma) rather than a separate backend. This is the cleanest single-component web template.
3. **C# ASP.NET Core Web API is a stable, recurring backend family** (.NET 7, EF Core, `appsettings.json`). It shows up every year (ooc-api, ida_api, UAMISHUB, DaVita-LSP-Backend, ua-baseball, Bio-ISAC, Mentorship). Crucially, these teams use **EF Core + Pomelo for MySQL**, not SQL Server.
4. **Python backends split into two uses:** web APIs (**Flask** — UA-MIS-S26; **FastAPI** — Davitabackend) and **data/ML scripts** (CatBoost, BigQuery ETL — catboosthealthAI, syntheacleaning, DatabaseUpdate). The data/ML group is batch, not a long-running service.
5. **Node/Express APIs** pair with React/RN front ends (SolarChauffeurF24 backend, AISserver). Express is the JS backend of choice when not using Next.
6. **React Native / Expo mobile is a distinct, recurring shape** (Game-Day-App, AISCapstoneApp, 5-Spot, AAC-S25, SolarChauffeur). These don't deploy to the cluster as web services — they consume a deployed API. Relevant only insofar as the *API* needs a template; the mobile app itself is out of the platform's web-hosting scope.
7. **Multi-component is the norm, expressed two ways:** sibling folders in one repo (`frontend/`+`backend/`, `app/`+`server/`, `client/`+`api/`) **and** separate repos per component (AIS\*, ooc-\*, DaVita-LSP-\*). The scaffolder must support FE+BE as one logical app.
8. **MySQL is the org's lingua-franca database** (mysql2 in Node, Pomelo-MySQL in C#, mysql-connector in Flask). Where teams escape it, they use *already-managed* cloud services (Firebase, GCP BigQuery, AWS Amplify) — i.e., they avoid self-hosting a DB.
9. **Students don't containerize.** ~90% of sampled repos have no Dockerfile. The few that do were the most "infra-aware" teams (and even those targeted GCP Cloud Run, not this cluster).
10. **Recurring auth/tooling:** **Clerk** (accounting-manager, standd, ida-dataset-search, AISserver — 4+), Vite, Tailwind+daisyUI, Prisma, Swagger (Express APIs), MSAL/Amplify on the cloud-native teams.

---

## 3. Recommended starter templates (prioritized)

Each template should ship a **working Dockerfile** (the #1 gap) and a **`.devops/` overlay** wired to the existing tenant onboarding contract.

**P1 — Next.js full-stack (TypeScript) + Prisma + MySQL** *(single-component)*
The 2025–2026 default. FE + API routes + DB in one deployable. Matches accounting-manager, standd, ida-dataset-search, MISHUB2.0. Include Prisma pointed at MySQL, optional Clerk auth env block, multi-stage Dockerfile (`next build` → standalone). **Highest coverage per template.**

**P2 — React (Vite) SPA front-end + Node/Express (TypeScript) API** *(multi-component: FE+BE, MySQL)*
The classic split-stack. FE language TS/JS, BE Node/Express TS. Matches DaVita-S26, SolarChauffeurF24, AISserver+AISCapstoneWeb, ooc-admin/student+(Node alt). Two services (static-served Vite build behind nginx + Express container) sharing one MySQL. This is the template that exercises the **multi-component** scaffolder path.

**P3 — C# ASP.NET Core Web API (.NET 8) + EF Core + MySQL** *(single-component backend; pairs with a React FE)*
The most durable backend family in the org, present every year. Ship EF Core + **Pomelo.EntityFrameworkCore.MySql**, `appsettings` wired to env/secrets, multi-stage SDK→runtime Dockerfile. FE is typically a separate React repo, so offer this as a standalone API template (combinable with P2's FE via multi-component).

**P4 — Python Flask **or** FastAPI API + MySQL** *(single-component backend)*
Covers the Python web-API teams (UA-MIS-S26 Flask, Davitabackend FastAPI). Ship gunicorn/uvicorn, mysql-connector or SQLAlchemy, slim Python Dockerfile. One template with a Flask/FastAPI toggle, or two thin variants.

**P5 — React (Vite or CRA) static front-end** *(single-component, no DB)*
For FE-only teams whose backend is a separate repo or a managed cloud service (ida-search, ida-content-manager, AISCapstoneWeb, GameDay portal). Build → static assets served by nginx. Cheap to provide, high reuse, and the natural FE half of any multi-component pairing.

**P6 (optional / lower) — Headless CMS (Strapi) + React**
Only Insitely uses it, but it recurs across that team's multiple repos and is awkward to scaffold by hand (needs a persistent DB + admin). Lower priority — single team.

**Language-mix combos to support explicitly in the multi-component template:** TS-FE + TS/JS-BE (P1/P2), TS/JS-FE + **C#**-BE (P3 — very common cross-language pairing here), TS/JS-FE + **Python**-BE (P4). The FE↔BE language is independent, so the multi-component template should let the user pick each side.

---

## 4. Answers to the two flagged questions

**Do many teams need a managed database?** **Yes — and specifically managed MySQL.** MySQL is the single most common dependency across all three language families (Node `mysql2`, C# `Pomelo.EntityFrameworkCore.MySql`, Flask `mysql-connector-python`). A push-button **managed MySQL** (per-tenant DB + injected connection secret) would serve the majority of teams directly and remove the most error-prone setup step. Postgres should be offered as the secondary option (Prisma-based teams are DB-agnostic and a few touch `pg`). Teams that already use Firebase / BigQuery / Amplify are self-sufficient on external managed services and need no cluster DB. This directly supports prioritizing the managed-DB workload option on the roadmap.

**Do many teams lack Dockerfiles?** **Yes — the overwhelming majority (~90% of the sample).** Only `UA-MIS-S26`, `ida-dataset-search`, `InsitelyV4Strapi`, and `Bio-ISAC-S26` shipped one (and Bio-ISAC's targeted GCP Cloud Run). Two implications: (1) every starter template must **provide a known-good Dockerfile** so onboarded teams build images without writing Dockerfile expertise they don't have; (2) there is real demand for a **VM / buildpack-style "no-Dockerfile" workload option** for existing repos that teams bring as-is and will never containerize themselves.

---

## References (repos cited, all `github.com/UA-MIS/<name>`)

Manifests read directly: `accounting-manager` (package.json), `standd` (package.json), `ida-dataset-search` (package.json), `DaVita-S26` (server/package.json), `AISserver` (api/package.json), `SolarChauffeurF24` (frontend+backend/package.json), `ooc-admin`/`ooc-student` (package.json), `5-Spot` (app/package.json), `VOCAL-S26`, `GameDay-Web-Portal`, `MISHUB2.0`, `Game-Day-App` (package.json); `ooc-api` + `ida_api` (`*.csproj` → .NET 7 / EF Core / Pomelo MySQL); `Bio-ISAC-S26` (csproj + ticketing-system/package.json + Dockerfiles); `UA-MIS-S26` + `Davitabackend` (requirements.txt → Flask/gunicorn/MySQL; FastAPI/BigQuery/CatBoost); `uainnovate` (composer.json). Tree/structure inspected for all ~44 sampled repos via `git/trees`.
