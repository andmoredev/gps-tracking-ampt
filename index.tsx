import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { data } from "@ampt/data";
import { ulid, decodeTime } from "ulid";
import { ws, SocketConnection } from "@ampt/sdk";
const app = new Hono();

app.notFound((c) => c.json({ message: "Not Found", ok: false }, 404));

app.post("/sessions", async (c) => {
  const id = ulid();
  const body = await c.req.json();

  if (!body.name) {
    throw new HTTPException(400, { message: "Name is required!" });
  }

  await data.set(`session:${id}`, {
    id,
    active: true,
    name: body.name,
  });

  c.status(201);
  return c.json({
    id: id,
  });
});

app.delete("/sessions/:id", async (c) => {
  const id = c.req.param("id");

  await data.remove(`session:${id}`);
  c.status(204);
  return c.body(null);
});

app.get("/sessions", async (c) => {
  const sessions = await data.get("session:*");

  return c.json(sessions);
});

app.get("/sessions/:id", async (c) => {
  const id = c.req.param("id");

  const session = await data.get(`session:${id}`, {
    meta: true,
  });

  return c.json(session);
});

app.put("/sessions/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();

  if (!body.name || body.active === undefined || body.active === null) {
    throw new HTTPException(400, {
      message: "Please provide name and active!",
    });
  }

  await data.set(`session:${id}`, {
    id,
    active: body.active,
    name: body.name,
  });

  c.status(204);
  return c.body(null);
});

app.post("/sessions/:id/data", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();

  if (!body.lat || !body.lng) {
    throw new HTTPException(400, { message: "Data is required!" });
  }

  let session;
  try {
    session = await data.set(
      `session:${id}`,
      {
        counter: { $add: 1 },
      },
      { exists: true }
    );
  } catch (error) {
    if (error.message === "Item does not exist") {
      throw new HTTPException(404, { message: "Session not found!" });
    }

    throw error;
  }

  if (!session.active) {
    throw new HTTPException(400, { message: "Session is not active!" });
  }

  const dataId = ulid();

  await data.set(`session#${id}:${dataId}`, {
    sessionId: id,
    dataId,
    lat: body.lat,
    lng: body.lng,
  });

  const connections = await data.getByLabel('label1', `session:${id}`)
  connections.items.forEach((connection: any) => {
    ws.send(connection.value.connectionId, {
      lat: body.lat,
      lng: body.lng,
    });
  });


  c.status(201);
  return c.json({
    id: dataId,
  });
});

app.get("/sessions/:id/data", async (c) => {
  const id = c.req.param("id");

  const getResponse = await data.get(`session#${id}:*`, {
    meta: true,
    reverse: true,
  });

  return c.json(getResponse);
});

data.on("updated:session:*", async (event) => {
  console.log('Counter', event.item.value.counter);
  if (
    event.item.value.counter % 10 == 0 &&
    event.item.value.counter != event.previous.value.counter
  ) {
    let totalDistance = 0;

    let getResponse: any = await data.get(`session#${event.item.value.id}:*`, {
      limit: 100,
      reverse: true,
    });

    const items = getResponse.items; // [];

    let previousItem;
    items.forEach((item: any) => {
      if (previousItem) {
        const distance = haversineDistance(
          {
            lat: item.value.lat,
            lon: item.value.lng,
          },
          {
            lat: previousItem.value.lat,
            lon: previousItem.value.lng,
          }
        );

        totalDistance += distance;
        previousItem = item;
      } else {
        previousItem = item;
      }
    });

    const latestTime = decodeTime(items[0].value.dataId);
    const earliestTime = decodeTime(items[items.length - 1].value.dataId);

    // Calculate the time difference in seconds
    const timeDifference = latestTime - earliestTime;
    console.log('timeDifference', timeDifference);

    // Calculate the speed in km/h
    const speedKmh = (totalDistance / timeDifference) * 3600.0;

    console.log("Total distance", totalDistance, "KM");
    console.log("Speed", speedKmh, "KM/h");

    await data.set(event.item.key, {
      distance: totalDistance,
      speed: speedKmh,
    });
  }
});

ws.on("connected", async (connection) => {
  const { connectionId } = connection;
  const sessionId = connection.meta.headers['X-Session-Id'] ?? connection.meta.queryStringParameters?.sessionId;

  if (await ws.isConnected(connectionId)) {
    if (!sessionId) {
      await ws.send(connectionId, "Session ID is required!");
      return;
    }

    const session = await data.get(`session:${sessionId}`);
    if (!session) {
      await ws.send(connectionId, "Session not found!");
      return;
    }

    await data.set(`connections:${connectionId}`, {
      connectionId: connectionId,
    },
    { label1: `session:${sessionId}` });
  } else {
    console.log(`Connection ${connectionId} is not connected!`);
  }
});

ws.on("disconnected", async (connection: SocketConnection, reason?: string) => {
  await data.remove(`connections:${connection.connectionId}`);
});

function haversineDistance(coord1, coord2) {
  const toRad = (value) => (value * Math.PI) / 180;

  const R = 6371; // Radius of the Earth in kilometers
  const lat1 = toRad(coord1.lat);
  const lon1 = toRad(coord1.lon);
  const lat2 = toRad(coord2.lat);
  const lon2 = toRad(coord2.lon);

  const dLat = lat2 - lat1;
  const dLon = lon2 - lon1;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  const distance = R * c; // Distance in kilometers

  return distance;
}

app.fire();

export default app;
