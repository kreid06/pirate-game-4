# Pirate Game - Client/Server Architecture

This is a multiplayer pirate ship physics game split into client and server components:

## Project Structure
- **client/**: TypeScript/Vite web application for browser gameplay
- **server/**: C-based game server for Linux deployment 
- **protocol/**: Shared protocol definitions and schemas
- **docs/**: Documentation and development guides

## Architecture Notes
- Client handles rendering, input, and prediction
- Server handles authoritative physics simulation and game state
- Communication via WebSockets with potential WebTransport upgrade
- Deterministic physics engine for consistent simulation

## Development Guidelines
- Use absolute paths when referencing cross-project files
- Follow existing code patterns from the original TypeScript implementation
- Maintain protocol compatibility between client and server
- Focus on performance and scalability for server components

[✅] Verify that the copilot-instructions.md file in the .github directory is created.
[✅] Clarify Project Requirements - Multi-project workspace for pirate game Client/Server architecture
[✅] Scaffold the Project - Created client (TypeScript/Vite), server (C), protocol (JSON), and docs structure
[✅] Customize the Project - Migrated all client code from pirate-game-3 to new structure
[ ] Install Required Extensions
[✅] Compile the Project - Client builds successfully, development server running on http://localhost:5173/
[✅] Create and Run Task - UDP Network Manager created for C server communication
[ ] Launch the Project
[ ] Ensure Documentation is Complete
[ ] Create and Run Task
[ ] Launch the Project
[ ] Ensure Documentation is Complete