# CSV Pro 📊

CSV Pro is a **High-Performance Desktop CSV Editor & Analytics Tool** designed to manage, explore, filter, and clean extremely large datasets (50,000+ rows) at sub-millisecond speeds. Built with a sleek React & Next.js frontend and a multithreaded Tauri & Rust backend.

---

## Key Features 🚀

- **Sub-Millisecond Engine**: Employs memory-mapped files and a custom zero-allocation byte parser in Rust. Large files open instantly and run search/filter queries under 5ms without freezing the UI.
- **Excel-Like Grid**: Interactive, premium, and fully keyboard-navigable datagrid featuring column resizing, instant inline cell editing, and active filters indicator.
- **Interactive Headers**: Checkbox checklists for distinct column values, quick A-Z/Z-A sorting, search bars inside filter popovers, and cumulative `AND`/`OR` multi-column filters.
- **Data Cleaning Tools**: One-click deduplication using parallel FNV-1a hashing, whitespace trimming, and filling missing values.
- **Analytics Operations**: High-performance CSV file joining and column/row splitting.
- **Clean CI/CD**: Seamlessly compiles native macOS bundles (Apple Silicon & Intel) and Windows installers (x64 & ARM64) on GitHub Actions.

---

## Tech Stack 🛠️

- **Frontend**: React, Next.js (Static Export), TypeScript, TailwindCSS, Lucide Icons.
- **Backend (Desktop Core)**: Tauri, Rust, Rayon (Parallel Computing), Memmap2 (Memory-mapped Files).
- **Tooling**: Node.js, Cargo, GitHub Actions.

---

## Getting Started 💻

### Prerequisites

Make sure you have installed:
- [Node.js](https://nodejs.org/) (v20+ recommended)
- [Rust & Cargo](https://www.rust-lang.org/) (stable)
- OS-specific Tauri dependencies (see [Tauri Setup Guide](https://tauri.app/v1/guides/getting-started/prerequisites/))

### Installation

1. Install frontend and build dependencies:
   ```bash
   npm install
   ```

2. Run the development server (automatically launches the Tauri desktop app window):
   ```bash
   npm run tauri dev
   ```

---

## Available Scripts 📜

In the project directory, you can run:

- **`npm run dev`**: Clears Next.js cache and runs Next.js server locally (`http://localhost:3000`).
- **`npm run tauri dev`**: Runs the app in Tauri development mode with hot-reloading.
- **`npm run clean`**: Cleans Next.js and static export build artifacts (`.next`, `out`).
- **`npm run clean:rust`**: Triggers `cargo clean` for the Rust backend target binaries.
- **`npm run build:mac-arm`**: Compiles native Apple Silicon macOS app bundle (`aarch64-apple-darwin`) and compresses it into a `.zip` archive preserving file signatures.
- **`npm run build:mac-intel`**: Compiles native Intel architecture macOS app bundle (`x86_64-apple-darwin`) and compresses it to `.zip`.
- **`npm run build:win`**: Packages standard Windows x64 `.msi` installers.
- **`npm run build:win-arm`**: Packages Windows ARM64 `.msi` installers.

---

## Release Pipeline 🚀

GitHub Action workflows are configured inside [.github/workflows/publish.yml](file://.github/workflows/publish.yml) to automatically compile, sign, and publish production binaries. 
Trigger a release by pushing a semver version tag:
```bash
git tag v1.0.0
git push origin v1.0.0
```

The CI/CD pipeline builds:
- **macOS (Intel)**: `x86_64-apple-darwin`
- **macOS (Silicon)**: `aarch64-apple-darwin`
- **Windows (x64)**: `x86_64-pc-windows-msvc`
- **Windows (ARM64)**: `aarch64-pc-windows-msvc`

Assets are automatically uploaded directly to your GitHub Releases as draft bundles.
