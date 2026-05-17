const state = {
  baseUrl: "",
  connected: false,
  drawing: false,
  points: [],
  marker: null,
  markerHeading: -Math.PI / 2,
  runId: 0,
  lastRoute: null,
  livePoints: [],
  liveMarker: null,
  liveHeading: -Math.PI / 2,
};

const routes = {
  "Station A": {
    "Main aisle": [
      { cmd: "forward", ms: 1100, dx: 0, dy: -90 },
      { cmd: "right", ms: 170, turn: 90 },
      { cmd: "forward", ms: 800, dx: 90, dy: 0 },
    ],
    "Wide safe route": [
      { cmd: "forward", ms: 700, dx: 0, dy: -70 },
      { cmd: "left", ms: 150, turn: -90 },
      { cmd: "forward", ms: 700, dx: -80, dy: 0 },
      { cmd: "right", ms: 150, turn: 90 },
      { cmd: "forward", ms: 700, dx: 0, dy: -70 },
    ],
  },
  "Station B": {
    "Main aisle": [
      { cmd: "forward", ms: 1300, dx: 0, dy: -120 },
      { cmd: "left", ms: 170, turn: -90 },
      { cmd: "forward", ms: 900, dx: -95, dy: 0 },
    ],
    "Short route": [
      { cmd: "forward", ms: 900, dx: 0, dy: -90 },
      { cmd: "right", ms: 140, turn: 70 },
      { cmd: "forward", ms: 1200, dx: 115, dy: -60 },
    ],
  },
  "Station C": {
    "Left route": [
      { cmd: "forward", ms: 800, dx: 0, dy: -80 },
      { cmd: "left", ms: 150, turn: -90 },
      { cmd: "forward", ms: 600, dx: -75, dy: 0 },
      { cmd: "right", ms: 150, turn: 90 },
      { cmd: "forward", ms: 900, dx: 0, dy: -90 },
    ],
    "Right route": [
      { cmd: "forward", ms: 800, dx: 0, dy: -80 },
      { cmd: "right", ms: 150, turn: 90 },
      { cmd: "forward", ms: 600, dx: 75, dy: 0 },
      { cmd: "left", ms: 150, turn: -90 },
      { cmd: "forward", ms: 900, dx: 0, dy: -90 },
    ],
  },
};

const $ = (id) => document.getElementById(id);

function log(message) {
  const time = new Date().toLocaleTimeString();
  const entry = document.createElement("div");
  entry.className = "log-entry";
  entry.textContent = `${time} - ${message}`;
  $("log").prepend(entry);
}

function setConnection(online) {
  state.connected = online;
  $("connectionState").textContent = online ? "Online" : "Offline";
  $("connectionState").className = `pill ${online ? "online" : "offline"}`;
}

async function api(path) {
  if (!state.baseUrl) {
    log("Enter ESP32 IP address first");
    throw new Error("Missing IP");
  }

  const response = await fetch(`${state.baseUrl}${path}`, { cache: "no-store" });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `HTTP ${response.status}`);
  }
  return response;
}

async function command(path, label = path) {
  try {
    await api(path);
    log(label);
    return true;
  } catch (error) {
    setConnection(false);
    log(`Command failed: ${label} - ${error.message}`);
    return false;
  }
}

async function refreshStatus() {
  if (!state.baseUrl) return;

  try {
    const response = await api("/status");
    const data = await response.json();
    setConnection(true);
    $("statusText").textContent = data.status || "Online";
    $("modeText").textContent = data.mode || "--";
    $("distanceText").textContent = data.distance ?? "--";
    $("obstacleText").textContent = data.ultrasonicObstacle ? "Blocked" : "Clear";
    if (Number(data.echoDuration) === 0) {
      $("obstacleText").textContent = "No Echo";
    }
  } catch {
    setConnection(false);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runStep(step, runId) {
  if (runId !== state.runId) return false;
  const sent = await sendRouteCommandWithObstacleWait(step, runId);
  if (!sent) return false;

  if (step.visualFrom && step.visualTo) {
    const ok = await animateLiveMove(step.visualFrom, step.visualTo, step.ms, runId);
    if (!ok) return false;
  } else if (typeof step.turn === "number") {
    const nextHeading = state.liveHeading + step.turn * Math.PI / 180;
    const ok = await animateLiveTurn(state.liveHeading, nextHeading, step.ms, runId);
    if (!ok) return false;
  } else {
    await sleep(step.ms);
  }

  await sleep(120);
  return runId === state.runId;
}

async function sendRouteCommandWithObstacleWait(step, runId) {
  const path = `/${step.cmd}?ms=${step.ms}`;
  const label = `${step.cmd} ${step.ms}ms`;

  while (runId === state.runId) {
    try {
      await api(path);
      log(label);
      return true;
    } catch (error) {
      if (!String(error.message).includes("ULTRASONIC OBSTACLE")) {
        setConnection(false);
        log(`Command failed: ${label} - ${error.message}`);
        return false;
      }

      log("Obstacle detected. Waiting for path to clear.");
      await command("/stop", "Paused for obstacle");

      const clear = await waitForObstacleClear(runId);
      if (!clear) return false;

      log("Path clear. Resuming route.");
    }
  }

  return false;
}

async function waitForObstacleClear(runId) {
  while (runId === state.runId) {
    try {
      const response = await api("/status");
      const data = await response.json();
      const blocked = data.ultrasonicObstacle || (typeof data.distance === "number" && data.distance <= 20);

      if (!blocked) {
        return true;
      }
    } catch (error) {
      setConnection(false);
      log(`Status check failed while waiting: ${error.message}`);
      return false;
    }

    await sleep(700);
  }

  return false;
}

function reverseSteps(steps) {
  return [...steps].reverse().map((step) => {
    if (step.cmd === "forward") return { ...step, cmd: "backward" };
    if (step.cmd === "backward") return { ...step, cmd: "forward" };
    if (step.cmd === "left") return { ...step, cmd: "right" };
    if (step.cmd === "right") return { ...step, cmd: "left" };
    if (step.cmd === "softleft") return { ...step, cmd: "softright" };
    if (step.cmd === "softright") return { ...step, cmd: "softleft" };
    return step;
  });
}

function pointsFromPreparedSteps(steps) {
  const points = [{ x: 0, y: 0 }];

  steps.forEach((step) => {
    if (step.visualTo) {
      points.push({ ...step.visualTo });
    }
  });

  return points;
}

function stepsFromPoints(points, initialHeading = -Math.PI / 2) {
  const steps = [];
  let heading = initialHeading;
  const turnScale = Number($("turnScale")?.value || 260);
  const driveScale = Number($("driveScale")?.value || 14);

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 1) continue;

    const target = Math.atan2(dy, dx);
    const diff = Math.atan2(Math.sin(target - heading), Math.cos(target - heading));

    if (Math.abs(diff) > 0.18) {
      steps.push({
        cmd: diff > 0 ? "right" : "left",
        ms: Math.min(900, Math.round(Math.abs(diff) * turnScale)),
        turn: diff * 180 / Math.PI,
      });
      heading = target;
    }

    steps.push({
      cmd: "forward",
      ms: Math.min(1200, Math.round(distance * driveScale)),
      dx,
      dy,
    });
  }

  return steps;
}

function samePathReturnSteps(deliverySteps) {
  const prepared = prepareVisualSteps(deliverySteps);
  const points = pointsFromPreparedSteps(prepared);

  if (points.length < 2) {
    return [];
  }

  const last = points[points.length - 1];
  const beforeLast = points[points.length - 2];
  const finalHeading = Math.atan2(last.y - beforeLast.y, last.x - beforeLast.x);
  const returnHeading = finalHeading + Math.PI;
  const reversePoints = [...points].reverse();

  return [
    { cmd: "right", ms: 520, turn: 180 },
    ...stepsFromPoints(reversePoints, returnHeading),
  ];
}

async function runDelivery(steps, name) {
  const runId = ++state.runId;
  const preparedSteps = prepareVisualSteps(steps);
  state.lastRoute = preparedSteps;

  log(`Starting delivery: ${name}`);
  setupLiveRoute(preparedSteps, name);

  for (const step of preparedSteps) {
    if (!await runStep(step, runId)) {
      log("Delivery stopped before reaching destination");
      return;
    }
  }

  log("Delivery complete. Returning home.");
  await sleep(600);

  const returnSteps = prepareVisualSteps(samePathReturnSteps(steps));
  setupLiveRoute(returnSteps, "Returning Home");

  for (const step of returnSteps) {
    if (!await runStep(step, runId)) {
      log("Return home stopped before docking");
      return;
    }
  }

  await command("/stop", "Docked at home");
  $("liveRouteLabel").textContent = "Docked";
}

async function runDynamicDelivery(steps, cleanPath) {
  const runId = ++state.runId;
  const preparedSteps = prepareVisualSteps(steps);
  state.lastRoute = steps;

  log("Starting dynamic delivery");
  setupLiveRoute(preparedSteps, "Dynamic Route");

  const manualOk = await command("/mode?name=manual", "Manual mode");
  if (!manualOk) return;

  for (const step of preparedSteps) {
    if (!await runStep(step, runId)) {
      log("Dynamic path stopped before destination");
      return;
    }
  }

  await command("/stop", "Reached dynamic destination");
  await sleep(500);

  log("Turning in place to return home");
  const turnBack = { cmd: "right", ms: 520, turn: 180 };
  if (!await runStep(turnBack, runId)) {
    log("Return turn failed");
    return;
  }

  const returnPath = [...cleanPath].reverse();
  const returnSteps = prepareVisualSteps(pathToSteps(returnPath));
  setupLiveRoute(returnSteps, "Returning Home");

  for (const step of returnSteps) {
    if (!await runStep(step, runId)) {
      log("Dynamic return stopped before home");
      return;
    }
  }

  await command("/stop", "Docked at home");
  $("liveRouteLabel").textContent = "Docked";
}

function setupTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((btn) => btn.classList.remove("active"));
      document.querySelectorAll(".page").forEach((page) => page.classList.remove("active"));
      tab.classList.add("active");
      $(`${tab.dataset.page}Page`).classList.add("active");
    });
  });
}

function setupConnection() {
  const savedIp = localStorage.getItem("esp32_ip");
  if (savedIp) {
    $("ipInput").value = savedIp;
    state.baseUrl = `http://${savedIp}`;
  }

  $("connectBtn").addEventListener("click", async () => {
    const ip = $("ipInput").value.trim().replace(/^https?:\/\//, "");
    if (!ip) return;

    localStorage.setItem("esp32_ip", ip);
    state.baseUrl = `http://${ip}`;
    await refreshStatus();
    log(`Connected to ${ip}`);
  });
}

function setupButtons() {
  document.querySelectorAll("[data-command]").forEach((button) => {
    button.addEventListener("click", () => command(button.dataset.command, button.textContent.trim()));
  });

  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => command(`/mode?name=${button.dataset.mode}`, `Mode: ${button.textContent.trim()}`));
  });

  $("emergencyBtn").addEventListener("click", async () => {
    state.runId++;
    resetLiveView("Emergency stopped");
    log("Emergency stop requested");
    for (let i = 0; i < 5; i++) {
      fetch(`${state.baseUrl}/emergency_stop`, { cache: "no-store" }).catch(() => {});
      fetch(`${state.baseUrl}/stop`, { cache: "no-store" }).catch(() => {});
      await sleep(80);
    }
    await refreshStatus();
  });

  $("returnHomeBtn").addEventListener("click", async () => {
    if (!state.lastRoute) {
      log("No previous route to reverse");
      return;
    }
    state.runId++;
    log("Returning home using last route");
    const returnSteps = prepareVisualSteps(samePathReturnSteps(state.lastRoute));
    setupLiveRoute(returnSteps, "Returning Home");
    for (const step of returnSteps) {
      if (!await runStep(step, state.runId)) return;
    }
    await command("/stop", "Docked at home");
  });

  $("clearLogBtn").addEventListener("click", () => $("log").innerHTML = "");
}

function setupRoutePlanner() {
  const destinationSelect = $("destinationSelect");
  const routeSelect = $("routeSelect");

  Object.keys(routes).forEach((destination) => {
    const option = document.createElement("option");
    option.value = destination;
    option.textContent = destination;
    destinationSelect.append(option);
  });

  function updateRouteOptions() {
    routeSelect.innerHTML = "";
    Object.keys(routes[destinationSelect.value]).forEach((routeName) => {
      const option = document.createElement("option");
      option.value = routeName;
      option.textContent = routeName;
      routeSelect.append(option);
    });
    drawRoutePreview();
  }

  destinationSelect.addEventListener("change", updateRouteOptions);
  routeSelect.addEventListener("change", drawRoutePreview);
  $("previewRouteBtn").addEventListener("click", drawRoutePreview);

  $("startDeliveryBtn").addEventListener("click", () => {
    const destination = destinationSelect.value;
    const routeName = routeSelect.value;
    runDelivery(routes[destination][routeName], `${destination} - ${routeName}`);
  });

  updateRouteOptions();
}

function drawRoutePreview() {
  const canvas = $("routePreview");
  const ctx = canvas.getContext("2d");
  const destination = $("destinationSelect").value;
  const routeName = $("routeSelect").value;
  const steps = routes[destination]?.[routeName] || [];
  const preparedSteps = prepareVisualSteps(steps);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const points = visualPointsForCanvas(preparedSteps, canvas.width, canvas.height);

  ctx.lineWidth = 6;
  ctx.lineCap = "round";
  ctx.strokeStyle = "#111827";
  ctx.beginPath();
  points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
  ctx.stroke();

  drawMarker(ctx, points[0], -Math.PI / 2, "#2f9e44");
  drawMarker(ctx, points[points.length - 1], -Math.PI / 2, "#2f80ed");
  setupLiveRoute(preparedSteps, `${destination} - ${routeName}`, false);
}

function drawMarker(ctx, point, heading, color) {
  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.rotate(heading + Math.PI / 2);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, -13);
  ctx.lineTo(10, 10);
  ctx.lineTo(0, 6);
  ctx.lineTo(-10, 10);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function setupDrawing() {
  const canvas = $("drawCanvas");
  const ctx = canvas.getContext("2d");

  function position(event) {
    const rect = canvas.getBoundingClientRect();
    const pointer = event.touches ? event.touches[0] : event;
    return {
      x: (pointer.clientX - rect.left) * canvas.width / rect.width,
      y: (pointer.clientY - rect.top) * canvas.height / rect.height,
    };
  }

  function draw() {
    const displayPoints = state.drawing ? liveStraightPath(state.points) : getDynamicPathPoints();

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#111827";
    ctx.beginPath();
    displayPoints.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
    ctx.stroke();

    if (displayPoints.length > 1) {
      const destination = displayPoints[displayPoints.length - 1];
      ctx.fillStyle = "#2f80ed";
      ctx.beginPath();
      ctx.arc(destination.x, destination.y, 9, 0, Math.PI * 2);
      ctx.fill();
    }

    const markerPoint = displayPoints[0] || state.marker || { x: canvas.width / 2, y: canvas.height - 34 };
    drawMarker(ctx, markerPoint, state.markerHeading, "#2f9e44");
  }

  function liveStraightPath(points) {
    return straightenPath(points);
  }

  function start(event) {
    state.drawing = true;
    state.points = [position(event)];
    state.marker = state.points[0];
    state.markerHeading = -Math.PI / 2;
    draw();
    event.preventDefault();
  }

  function move(event) {
    if (!state.drawing) return;
    const point = position(event);
    const last = state.points[state.points.length - 1];
    if (Math.hypot(point.x - last.x, point.y - last.y) > 8) {
      state.points.push(point);
      draw();
    }
    event.preventDefault();
  }

  function end() {
    state.drawing = false;
    draw();
  }

  canvas.addEventListener("mousedown", start);
  canvas.addEventListener("mousemove", move);
  window.addEventListener("mouseup", end);
  canvas.addEventListener("touchstart", start);
  canvas.addEventListener("touchmove", move);
  window.addEventListener("touchend", end);

  $("clearPathBtn").addEventListener("click", async () => {
    state.runId++;
    state.points = [];
    state.marker = null;
    state.markerHeading = -Math.PI / 2;
    draw();
    resetLiveView("Path cleared");
    await command("/stop", "Path cleared and rover stopped");
  });

  $("runDynamicBtn").addEventListener("click", async () => {
    const reachable = await command("/ping", "Rover connection check");
    if (!reachable) {
      log("Dynamic path cancelled because rover is not reachable");
      return;
    }

    const cleanPath = getDynamicPathPoints();
    state.points = cleanPath;
    state.marker = cleanPath[0] || null;
    draw();

    if (cleanPath.length < 2) {
      log("Draw a longer path first");
      return;
    }

    const steps = pathToSteps(cleanPath);
    if (steps.length === 0) {
      log("Path is too short after straightening");
      return;
    }

    log(`Dynamic path ready: ${cleanPath.length} points, ${steps.length} commands`);
    log(`First commands: ${steps.slice(0, 4).map((s) => `${s.cmd}:${s.ms}`).join(", ")}`);
    runDynamicDelivery(steps, cleanPath);
  });

  draw();
}

function simplifyPath(points) {
  if (points.length < 2) return [];
  const simplified = [points[0]];
  let carry = 0;
  let last = points[0];

  for (let i = 1; i < points.length; i++) {
    const point = points[i];
    carry += Math.hypot(point.x - last.x, point.y - last.y);
    if (carry >= 34) {
      simplified.push(point);
      carry = 0;
    }
    last = point;
  }

  const end = points[points.length - 1];
  if (simplified[simplified.length - 1] !== end) simplified.push(end);
  return simplified;
}

function straightenPath(points, tolerance = 32) {
  if (points.length <= 2) return points;

  function perpendicularDistance(point, start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;

    if (dx === 0 && dy === 0) {
      return Math.hypot(point.x - start.x, point.y - start.y);
    }

    return Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x) /
      Math.hypot(dx, dy);
  }

  function simplifySection(section) {
    if (section.length <= 2) return section;

    let maxDistance = 0;
    let splitIndex = 0;
    const start = section[0];
    const end = section[section.length - 1];

    for (let i = 1; i < section.length - 1; i++) {
      const distance = perpendicularDistance(section[i], start, end);
      if (distance > maxDistance) {
        maxDistance = distance;
        splitIndex = i;
      }
    }

    if (maxDistance <= tolerance) {
      return [start, end];
    }

    const left = simplifySection(section.slice(0, splitIndex + 1));
    const right = simplifySection(section.slice(splitIndex));
    return left.slice(0, -1).concat(right);
  }

  return simplifySection(simplifyPath(points));
}

function getDynamicPathPoints() {
  const straightened = straightenPath(state.points);
  return applyDynamicDirection(straightened);
}

function applyDynamicDirection(points) {
  if (points.length < 2) return points;

  const direction = $("dynamicDirection")?.value || "home_first";

  if (direction === "drawn") {
    return points;
  }

  if (direction === "reverse") {
    return [...points].reverse();
  }

  const canvas = $("drawCanvas");
  const home = { x: canvas.width / 2, y: canvas.height - 34 };
  const first = points[0];
  const last = points[points.length - 1];
  const firstDistance = Math.hypot(first.x - home.x, first.y - home.y);
  const lastDistance = Math.hypot(last.x - home.x, last.y - home.y);

  return firstDistance <= lastDistance ? points : [...points].reverse();
}

function pathToSteps(points) {
  const steps = [];
  let heading = -Math.PI / 2;
  const turnScale = Number($("turnScale").value);
  const driveScale = Number($("driveScale").value);

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 18) continue;

    const target = Math.atan2(dy, dx);
    const diff = Math.atan2(Math.sin(target - heading), Math.cos(target - heading));

    if (Math.abs(diff) > 0.18) {
      steps.push({
        cmd: diff > 0 ? "right" : "left",
        ms: Math.min(900, Math.round(Math.abs(diff) * turnScale)),
        turn: diff * 180 / Math.PI,
      });
      heading = target;
    }

    steps.push({
      cmd: "forward",
      ms: Math.min(1200, Math.round(distance * driveScale)),
      dx,
      dy,
    });
  }

  return steps;
}

function prepareVisualSteps(steps, reverseVisual = false) {
  let x = 0;
  let y = 0;

  return steps.map((step) => {
    const prepared = { ...step };

    if (prepared.dx || prepared.dy) {
      const from = { x, y };
      const dx = reverseVisual ? -(prepared.dx || 0) : (prepared.dx || 0);
      const dy = reverseVisual ? -(prepared.dy || 0) : (prepared.dy || 0);
      x += dx;
      y += dy;
      prepared.visualFrom = from;
      prepared.visualTo = { x, y };
    }

    return prepared;
  });
}

function visualPointsForCanvas(steps, width, height) {
  const raw = [{ x: 0, y: 0 }];

  steps.forEach((step) => {
    if (step.visualTo) {
      raw.push(step.visualTo);
    }
  });

  if (raw.length === 1) {
    return [{ x: width / 2, y: height - 34 }];
  }

  const minX = Math.min(...raw.map((p) => p.x));
  const maxX = Math.max(...raw.map((p) => p.x));
  const minY = Math.min(...raw.map((p) => p.y));
  const maxY = Math.max(...raw.map((p) => p.y));
  const routeW = Math.max(1, maxX - minX);
  const routeH = Math.max(1, maxY - minY);
  const pad = 38;
  const scale = Math.min((width - pad * 2) / routeW, (height - pad * 2) / routeH, 1.6);
  const offsetX = (width - routeW * scale) / 2 - minX * scale;
  const offsetY = (height - routeH * scale) / 2 - minY * scale;

  return raw.map((p) => ({
    x: p.x * scale + offsetX,
    y: p.y * scale + offsetY,
  }));
}

function setupLiveRoute(steps, label, resetMarker = true) {
  const canvas = $("liveMap");
  state.livePoints = visualPointsForCanvas(steps, canvas.width, canvas.height);
  if (resetMarker) {
    state.liveMarker = state.livePoints[0] || { x: canvas.width / 2, y: canvas.height - 34 };
    state.liveHeading = -Math.PI / 2;
  }
  $("liveRouteLabel").textContent = label;
  drawLiveMap();
}

function drawLiveMap() {
  const canvas = $("liveMap");
  const ctx = canvas.getContext("2d");

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (state.livePoints.length > 1) {
    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.beginPath();
    state.livePoints.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
    ctx.stroke();

    state.livePoints.forEach((point, index) => {
      ctx.fillStyle = index === 0 ? "#2f9e44" : index === state.livePoints.length - 1 ? "#2f80ed" : "#94a3b8";
      ctx.beginPath();
      ctx.arc(point.x, point.y, index === 0 || index === state.livePoints.length - 1 ? 7 : 4, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  drawMarker(ctx, state.liveMarker || { x: canvas.width / 2, y: canvas.height - 34 }, state.liveHeading, "#f59f00");
}

function resetLiveView(label = "Home Dock") {
  const canvas = $("liveMap");
  state.livePoints = [];
  state.liveMarker = { x: canvas.width / 2, y: canvas.height - 34 };
  state.liveHeading = -Math.PI / 2;
  $("liveRouteLabel").textContent = label;
  drawLiveMap();
}

function livePointForStep(step, pointType) {
  const raw = pointType === "from" ? step.visualFrom : step.visualTo;
  const allRaw = [{ x: 0, y: 0 }];
  const routeSteps = state.livePoints;

  if (!raw || routeSteps.length === 0) return null;

  const prepared = state.lastRoute || [];
  const points = visualPointsForCanvas(prepared, $("liveMap").width, $("liveMap").height);
  const index = prepared.findIndex((candidate) => candidate === step);
  if (index < 0) return null;
  return pointType === "from" ? points[index] : points[index + 1];
}

async function animateLiveMove(fromRaw, toRaw, ms, runId) {
  const canvas = $("liveMap");
  const points = state.livePoints;
  if (points.length < 2) {
    await sleep(ms);
    return runId === state.runId;
  }

  const from = state.liveMarker || points[0];
  let to = points.find((point) => Math.abs(point.x - from.x) > 1 || Math.abs(point.y - from.y) > 1);
  const currentIndex = points.findIndex((point) => Math.abs(point.x - from.x) < 2 && Math.abs(point.y - from.y) < 2);
  if (currentIndex >= 0 && currentIndex + 1 < points.length) {
    to = points[currentIndex + 1];
  }
  if (!to) {
    await sleep(ms);
    return runId === state.runId;
  }

  const start = performance.now();
  return new Promise((resolve) => {
    function frame(now) {
      if (runId !== state.runId) return resolve(false);
      const k = Math.min(1, (now - start) / ms);
      state.liveMarker = {
        x: from.x + (to.x - from.x) * k,
        y: from.y + (to.y - from.y) * k,
      };
      state.liveHeading = Math.atan2(to.y - from.y, to.x - from.x);
      drawLiveMap();
      if (k < 1) requestAnimationFrame(frame);
      else resolve(true);
    }
    requestAnimationFrame(frame);
  });
}

async function animateLiveTurn(fromHeading, toHeading, ms, runId) {
  const start = performance.now();
  return new Promise((resolve) => {
    function frame(now) {
      if (runId !== state.runId) return resolve(false);
      const k = Math.min(1, (now - start) / ms);
      const diff = Math.atan2(Math.sin(toHeading - fromHeading), Math.cos(toHeading - fromHeading));
      state.liveHeading = fromHeading + diff * k;
      drawLiveMap();
      if (k < 1) requestAnimationFrame(frame);
      else resolve(true);
    }
    requestAnimationFrame(frame);
  });
}

function setupCalibration() {
  ["leftSpeed", "rightSpeed", "turnSpeed", "turnScale", "driveScale"].forEach((id) => {
    const input = $(id);
    const output = $(`${id}Value`);
    input.addEventListener("input", () => output.textContent = input.value);
  });

  $("saveSpeedBtn").addEventListener("click", () => {
    const left = $("leftSpeed").value;
    const right = $("rightSpeed").value;
    const turn = $("turnSpeed").value;
    command(`/speed?left=${left}&right=${right}&turn=${turn}`, "Calibration applied");
  });
}

function init() {
  setupTabs();
  setupConnection();
  setupButtons();
  setupRoutePlanner();
  setupDrawing();
  setupCalibration();
  resetLiveView();
  setInterval(refreshStatus, 800);
  refreshStatus();
}

init();
