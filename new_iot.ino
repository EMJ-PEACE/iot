#include <WiFi.h>
#include <WebServer.h>
#include <Arduino.h>

// =====================================
// WIFI
// =====================================

const char* ssid = "SSID";
const char* password = "PASSWORD";

WebServer server(80);

// =====================================
// L298N MOTOR DRIVER
// =====================================

const int enA = 5;
const int enB = 23;

const int IN1 = 22;
const int IN2 = 21;

const int IN3 = 19;
const int IN4 = 18;

int leftSpeed = 120;
int rightSpeed = 120;
int turnSpeed = 120;
int slowSpeed = 90;

// =====================================
// SENSORS
// =====================================

const int TRIG_PIN = 26;
const int ECHO_PIN = 27;

const int UL_LIMIT_MIN = 8;
const int UL_LIMIT_MID = 20;
const int UL_LIMIT_MAX = 60;

// =====================================
// STATE
// =====================================

enum ControlMode {
  MANUAL_MODE,
  ULTRASONIC_AVOIDANCE_MODE,
  ULTRASONIC_FOLLOW_MODE,
  OBSTACLE_AVOIDANCE_MODE
};

ControlMode controlMode = MANUAL_MODE;

String robotStatus = "Idle";

unsigned long lastCommandTime = 0;
const unsigned long COMMAND_TIMEOUT_MS = 1500;

bool timedMoveActive = false;
unsigned long timedMoveEnd = 0;
bool forwardMotionActive = false;

// =====================================
// SETUP
// =====================================

void setup() {
  Serial.begin(115200);

  pinMode(enA, OUTPUT);
  pinMode(enB, OUTPUT);

  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  pinMode(IN3, OUTPUT);
  pinMode(IN4, OUTPUT);

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  digitalWrite(TRIG_PIN, LOW);

  stopBot();

  WiFi.begin(ssid, password);

  Serial.print("Connecting WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println();
  Serial.println("WiFi Connected");
  Serial.print("ESP32 IP: ");
  Serial.println(WiFi.localIP());

  registerRoutes();

  server.begin();

  Serial.println("Robot API Started");
  Serial.println("Port: 80");

  lastCommandTime = millis();
}

// =====================================
// LOOP
// =====================================

void loop() {
  server.handleClient();

  if (forwardMotionActive && isUltrasonicObstacleDetected()) {
    timedMoveActive = false;
    forwardMotionActive = false;
    stopBot();
    robotStatus = "Obstacle detected - stopped";
  }

  if (timedMoveActive && millis() >= timedMoveEnd) {
    timedMoveActive = false;
    forwardMotionActive = false;
    stopBot();
    robotStatus = "Timed move complete";
  }

  switch (controlMode) {
    case MANUAL_MODE:
      if (!timedMoveActive && millis() - lastCommandTime > COMMAND_TIMEOUT_MS) {
        stopBot();
      }
      break;

    case ULTRASONIC_AVOIDANCE_MODE:
      handleUltrasonicAvoidance();
      break;

    case ULTRASONIC_FOLLOW_MODE:
      handleUltrasonicFollow();
      break;

    case OBSTACLE_AVOIDANCE_MODE:
      handleUltrasonicAvoidance();
      break;
  }
}

// =====================================
// ROUTES
// =====================================

void registerRoutes() {
  server.on("/", HTTP_GET, handleRoot);
  server.on("/ping", HTTP_GET, handlePing);
  server.on("/status", HTTP_GET, handleStatus);

  server.on("/forward", HTTP_GET, handleForward);
  server.on("/backward", HTTP_GET, handleBackward);
  server.on("/left", HTTP_GET, handleLeft);
  server.on("/right", HTTP_GET, handleRight);
  server.on("/softleft", HTTP_GET, handleSoftLeft);
  server.on("/softright", HTTP_GET, handleSoftRight);
  server.on("/stop", HTTP_GET, handleStop);

  server.on("/speed", HTTP_GET, handleSpeed);
  server.on("/mode", HTTP_GET, handleMode);
  server.on("/emergency_stop", HTTP_GET, handleEmergencyStop);
  server.on("/motor_test", HTTP_GET, handleMotorTest);

  server.onNotFound(handleNotFound);
}

void addCors() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
}

void sendText(int code, String message) {
  addCors();
  server.send(code, "text/plain", message);
}

void sendJson(String json) {
  addCors();
  server.send(200, "application/json", json);
}

void handleRoot() {
  sendText(200, "ESP32 Rover API is running");
}

void handlePing() {
  sendText(200, "pong");
}

void handleNotFound() {
  sendText(404, "Route not found");
}

void handleStatus() {
  unsigned long echoDuration = getEchoDuration();
  long distance = durationToDistanceCm(echoDuration);
  bool ultrasonicObstacle = isUltrasonicObstacleDetected(distance);

  String json = "{";
  json += "\"online\":true";
  json += ",\"status\":\"" + robotStatus + "\"";
  json += ",\"mode\":\"" + getModeName() + "\"";
  json += ",\"distance\":";
  json += distance;
  json += ",\"echoDuration\":";
  json += echoDuration;
  json += ",\"ultrasonicObstacle\":";
  json += ultrasonicObstacle ? "true" : "false";
  json += ",\"leftSpeed\":";
  json += leftSpeed;
  json += ",\"rightSpeed\":";
  json += rightSpeed;
  json += ",\"turnSpeed\":";
  json += turnSpeed;
  json += ",\"slowSpeed\":";
  json += slowSpeed;
  json += "}";

  sendJson(json);
}

// =====================================
// COMMAND ROUTES
// Optional: add ?ms=500 to auto-stop after that time.
// =====================================

void handleForward() {
  setManualCommand("Forward");

  if (!safeToMoveForward()) {
    sendText(409, "ULTRASONIC OBSTACLE - FORWARD BLOCKED");
    return;
  }

  forward();
  applyOptionalDuration();
  sendText(200, "FORWARD");
}

void handleBackward() {
  setManualCommand("Backward");
  backward();
  applyOptionalDuration();
  sendText(200, "BACKWARD");
}

void handleLeft() {
  setManualCommand("Left");
  leftTurn();
  applyOptionalDuration();
  sendText(200, "LEFT");
}

void handleRight() {
  setManualCommand("Right");
  rightTurn();
  applyOptionalDuration();
  sendText(200, "RIGHT");
}

void handleSoftLeft() {
  setManualCommand("Soft left");

  if (!safeToMoveForward()) {
    sendText(409, "ULTRASONIC OBSTACLE - SOFT LEFT BLOCKED");
    return;
  }

  forwardLeft();
  applyOptionalDuration();
  sendText(200, "SOFT LEFT");
}

void handleSoftRight() {
  setManualCommand("Soft right");

  if (!safeToMoveForward()) {
    sendText(409, "ULTRASONIC OBSTACLE - SOFT RIGHT BLOCKED");
    return;
  }

  forwardRight();
  applyOptionalDuration();
  sendText(200, "SOFT RIGHT");
}

void handleStop() {
  controlMode = MANUAL_MODE;
  timedMoveActive = false;
  forwardMotionActive = false;
  lastCommandTime = millis();
  robotStatus = "Stopped";
  stopBot();
  sendText(200, "STOP");
}

void handleEmergencyStop() {
  controlMode = MANUAL_MODE;
  timedMoveActive = false;
  forwardMotionActive = false;
  lastCommandTime = millis();
  robotStatus = "Emergency stopped";
  stopBot();
  sendText(200, "EMERGENCY STOP");
}

void handleSpeed() {
  if (server.hasArg("left")) {
    leftSpeed = constrain(server.arg("left").toInt(), 0, 255);
  }

  if (server.hasArg("right")) {
    rightSpeed = constrain(server.arg("right").toInt(), 0, 255);
  }

  if (server.hasArg("turn")) {
    turnSpeed = constrain(server.arg("turn").toInt(), 0, 255);
  }

  if (server.hasArg("slow")) {
    slowSpeed = constrain(server.arg("slow").toInt(), 0, 255);
  }

  robotStatus = "Speed updated";
  sendText(200, "SPEED UPDATED");
}

void handleMode() {
  String mode = server.arg("name");

  timedMoveActive = false;
  forwardMotionActive = false;
  lastCommandTime = millis();

  if (mode == "manual") {
    controlMode = MANUAL_MODE;
    stopBot();
  } else if (mode == "ultra_avoid") {
    controlMode = ULTRASONIC_AVOIDANCE_MODE;
  } else if (mode == "follow") {
    controlMode = ULTRASONIC_FOLLOW_MODE;
  } else if (mode == "combined_avoid") {
    controlMode = OBSTACLE_AVOIDANCE_MODE;
  } else {
    sendText(400, "UNKNOWN MODE");
    return;
  }

  robotStatus = "Mode changed";
  sendText(200, "MODE UPDATED");
}

void handleMotorTest() {
  controlMode = MANUAL_MODE;
  timedMoveActive = false;
  forwardMotionActive = false;
  lastCommandTime = millis();
  robotStatus = "Motor test running";

  forward();
  delay(700);
  stopBot();
  delay(250);

  backward();
  delay(700);
  stopBot();
  delay(250);

  leftTurn();
  delay(500);
  stopBot();
  delay(250);

  rightTurn();
  delay(500);
  stopBot();

  robotStatus = "Motor test complete";
  sendText(200, "MOTOR TEST DONE");
}

void setManualCommand(String statusText) {
  controlMode = MANUAL_MODE;
  timedMoveActive = false;
  forwardMotionActive = false;
  lastCommandTime = millis();
  robotStatus = statusText;
}

void applyOptionalDuration() {
  if (!server.hasArg("ms")) {
    return;
  }

  int durationMs = constrain(server.arg("ms").toInt(), 1, 5000);
  timedMoveActive = true;
  timedMoveEnd = millis() + durationMs;
}

// =====================================
// AUTO MODES
// =====================================

void handleUltrasonicAvoidance() {
  long frontDistance = getDistanceCm();

  robotStatus = "Ultrasonic avoidance";

  if (frontDistance <= UL_LIMIT_MIN) {
    backward();
    delay(250);
    stopBot();
    delay(80);
  } else if (frontDistance < UL_LIMIT_MID) {
    stopBot();
    delay(100);
    rightTurn();
    delay(330);
    stopBot();
  } else {
    forward();
  }
}

void handleUltrasonicFollow() {
  long frontDistance = getDistanceCm();

  robotStatus = "Ultrasonic follow";

  if (frontDistance <= 5) {
    backward();
  } else if (frontDistance > 5 && frontDistance < 12) {
    stopBot();
  } else if (frontDistance >= 12 && frontDistance <= UL_LIMIT_MAX) {
    setMotorSpeed(slowSpeed, slowSpeed);
    driveForwardDirection();
  } else {
    stopBot();
  }

  delay(40);
}

// =====================================
// SENSOR FUNCTIONS
// =====================================

unsigned long getEchoDuration() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);

  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  return pulseIn(ECHO_PIN, HIGH, 40000);
}

long durationToDistanceCm(unsigned long duration) {
  if (duration == 0) {
    return 999;
  }

  return duration / 58;
}

long getDistanceCm() {
  return durationToDistanceCm(getEchoDuration());
}

bool isUltrasonicObstacleDetected() {
  return isUltrasonicObstacleDetected(getDistanceCm());
}

bool isUltrasonicObstacleDetected(long distance) {
  return distance > 0 && distance <= UL_LIMIT_MID;
}

bool safeToMoveForward() {
  if (!isUltrasonicObstacleDetected()) {
    return true;
  }

  forwardMotionActive = false;
  timedMoveActive = false;
  stopBot();
  robotStatus = "Ultrasonic obstacle - blocked";
  return false;
}

String getModeName() {
  switch (controlMode) {
    case MANUAL_MODE:
      return "Manual";
    case ULTRASONIC_AVOIDANCE_MODE:
      return "Ultrasonic Avoidance";
    case ULTRASONIC_FOLLOW_MODE:
      return "Ultrasonic Follow";
    case OBSTACLE_AVOIDANCE_MODE:
      return "Obstacle Avoidance";
  }

  return "Unknown";
}

// =====================================
// MOTOR FUNCTIONS
// =====================================

void setMotorSpeed(int left, int right) {
  analogWrite(enA, left);
  analogWrite(enB, right);
}

void driveForwardDirection() {
  digitalWrite(IN1, HIGH);
  digitalWrite(IN2, LOW);

  digitalWrite(IN3, HIGH);
  digitalWrite(IN4, LOW);
}

void driveBackwardDirection() {
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, HIGH);

  digitalWrite(IN3, LOW);
  digitalWrite(IN4, HIGH);
}

void forward() {
  forwardMotionActive = true;
  setMotorSpeed(leftSpeed, rightSpeed);
  driveForwardDirection();
}

void backward() {
  forwardMotionActive = false;
  setMotorSpeed(leftSpeed, rightSpeed);
  driveBackwardDirection();
}

void leftTurn() {
  forwardMotionActive = false;
  setMotorSpeed(turnSpeed, turnSpeed);

  digitalWrite(IN1, HIGH);
  digitalWrite(IN2, LOW);

  digitalWrite(IN3, LOW);
  digitalWrite(IN4, HIGH);
}

void rightTurn() {
  forwardMotionActive = false;
  setMotorSpeed(turnSpeed, turnSpeed);

  digitalWrite(IN1, LOW);
  digitalWrite(IN2, HIGH);

  digitalWrite(IN3, HIGH);
  digitalWrite(IN4, LOW);
}

void forwardLeft() {
  forwardMotionActive = true;
  setMotorSpeed(leftSpeed / 3, rightSpeed);
  driveForwardDirection();
}

void forwardRight() {
  forwardMotionActive = true;
  setMotorSpeed(leftSpeed, rightSpeed / 3);
  driveForwardDirection();
}

void stopBot() {
  forwardMotionActive = false;
  setMotorSpeed(0, 0);

  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);

  digitalWrite(IN3, LOW);
  digitalWrite(IN4, LOW);
}
