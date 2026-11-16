# Roblox 64 Multiplayer Server

A starter Node.js WebSocket server for real-time Roblox 64 game sessions.

## Deploy on Render

Create a **new Web Service** connected to this repository. Do not change the old Minecraft Fighter service.

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/health`
- Instance count: keep this at **1** for this in-memory starter

Render provides the public HTTPS URL. The WebSocket URL is the same hostname with `wss://` and the `/ws` path, for example:

`wss://YOUR-SERVICE.onrender.com/ws`

## HTTP endpoints

- `GET /` - basic service information
- `GET /health` - health check

## WebSocket protocol

Connect to `/ws`. Send JSON messages.

### Join a room

```json
{
  "type": "join",
  "gameId": "pizza-place",
  "roomId": "public",
  "displayName": "Player"
}
```

- `gameId` separates different Roblox 64 games.
- `roomId` separates sessions within a game. Use `public` for the default room or provide a room code.
- Each room has a maximum of 30 connected players.
- The server assigns each connection its own player ID.

### Update player state

```json
{
  "type": "player:update",
  "state": { "x": 12, "y": 4, "animation": "walk" }
}
```

Other players in the same room receive:

```json
{
  "type": "player:updated",
  "playerId": "server-assigned-id",
  "state": { "x": 12, "y": 4, "animation": "walk" }
}
```

### Send a game event

```json
{
  "type": "game:event",
  "event": "round.started",
  "data": { "round": 1 }
}
```

### Room chat

```json
{ "type": "chat:send", "text": "Hello!" }
```

### Server messages

- `hello` - protocol greeting
- `joined` - confirms room entry and includes the current player list
- `player:joined` / `player:left` - presence updates
- `player:updated` - another player's latest state
- `game:event` - game event from another player
- `chat:message` - room chat message
- `error` - request or connection error

## Important limitations of this starter

- Rooms and player state are stored **in server memory**. A restart or deploy clears them.
- Keep the service at one instance. Multiple instances would have separate room maps, so players could be split across instances. A shared data layer/message broker is needed before scaling horizontally.
- This is a networking foundation, not a complete game backend. The game client still needs to connect, join the correct game/room, send updates, and apply updates from other players.
- It does not yet include account authentication, moderation tools, persistent profiles, matchmaking, or anti-cheat validation. Do not treat client-sent movement or game events as trusted game results.
- Do not put passwords, API keys, or private tokens in client messages or this repository.

## Local test

```bash
npm install
npm start
```

Then visit `http://localhost:10000/health` or connect a WebSocket client to `ws://localhost:10000/ws`.
