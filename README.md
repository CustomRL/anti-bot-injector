# Anti-Bot Injector

A specialized launcher for managing and injecting the Anti-Bot module into Rocket League.

## Functions

- **Module Management**: Fetches the latest AntiBot.dll from the release server and verifies its SHA256 checksum before injection.
- **Injection Logic**: Utilizes a PowerShell-based remote thread injector to attach the module to the target process.
- **Session Handover**: Transmits an authenticated session token to the injected DLL via named pipes to unlock protected features.
- **Diagnostics**: Performs environment checks for Visual C++ Redistributables, Administrator access, and Windows Defender path exclusions.

## Setup and Development

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Launch Development Environment**:
   ```bash
   npm start
   ```

3. **Compile Portable Binary**:
   ```bash
   npm run dist
   ```

## Technical Details

- **Main Process**: Electron handles IPC, filesystem management, and system-level injection.
- **Renderer**: React-driven interface utilizing Babel Standalone for runtime JSX processing.
- **Security**: DevTools and standard inspection shortcuts are disabled. Discord OAuth is used for session validation.

