import { Router } from 'express';

export default function createGameRoutes({ rooms, createRoom, addPlayer, applyScore, saveRooms }) {
  const router = Router();

  router.post('/rooms', async (req, res) => {
    try {
      const room = createRoom(req.body);
      rooms[room.id] = room;
      await saveRooms(rooms);
      return res.status(201).json(room);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.get('/rooms/:roomId', (req, res) => {
    const room = rooms[req.params.roomId];
    if (!room) return res.status(404).json({ error: 'Room lama helin.' });
    return res.json(room);
  });

  router.post('/rooms/:roomId/players', async (req, res) => {
    const room = rooms[req.params.roomId];
    if (!room) return res.status(404).json({ error: 'Room lama helin.' });
    try {
      addPlayer(room, req.body);
      await saveRooms(rooms);
      return res.status(201).json(room);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.post('/rooms/:roomId/scores', async (req, res) => {
    const room = rooms[req.params.roomId];
    if (!room) return res.status(404).json({ error: 'Room lama helin.' });
    try {
      const result = applyScore(room, req.body.winnerName, req.body.victimName);
      await saveRooms(rooms);
      return res.json(result);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  return router;
}