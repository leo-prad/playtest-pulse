--[[
	Telemetry (Playtest Pulse SDK)
	--------------------------------
	Drop-in server-side telemetry for Roblox games. Batches gameplay events and
	player feedback, flushes them to your Playtest Pulse backend over HTTP.

	SERVER-SIDE ONLY. HttpService requests only run on the server, and keeping
	telemetry server-authoritative means a client can't spoof your analytics —
	the same principle you'd use for currency or transactions.

	SETUP
	  1. Studio > Game Settings > Security > Allow HTTP Requests: ON
	  2. Place this ModuleScript in ServerScriptService (or RS.Shared).
	  3. From a Script:
	         local Telemetry = require(path.to.Telemetry)
	         Telemetry.Configure({
	             endpoint = "https://your-app.example.com",
	             apiKey   = "pk_xxx", -- from your dashboard
	         })
	         Telemetry.init()

	USAGE
	     Telemetry.StartSession(player)
	     Telemetry.Track(player, "level_started", { level = 3 })
	     Telemetry.SubmitFeedback(player, "the boss felt unfair")
	     Telemetry.EndSession(player) -- optional; auto-fires on leave
--]]

local Telemetry = {}

-------------------// SERVICES \\--------------------

local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local Players = game:GetService("Players")

-----------------// REFERENCES \\--------------------

--// Constants
local DEFAULT_FLUSH_INTERVAL = 5
local MAX_BUFFERED_EVENTS = 200

--// Variables
local config = {
	endpoint = "http://localhost:3000",
	apiKey = "",
	flushInterval = DEFAULT_FLUSH_INTERVAL,
}

local buffers: { [Player]: BufferData } = {}
local running = false

type EventData = { name: string, properties: { [string]: any }?, client_ts: number }
type BufferData = {
	sessionId: string?,
	startedAt: number,
	events: { EventData },
	feedback: { { content: string } },
	ended: boolean,
}

----------------// PRIV. FUNCTIONS \\----------------

local function _bufferFor(player: Player): BufferData
	local buffer = buffers[player]
	if not buffer then
		buffer = {
			sessionId = nil,
			startedAt = os.time() * 1000,
			events = {},
			feedback = {},
			ended = false,
		}
		buffers[player] = buffer
	end
	return buffer
end

-- POST one player's pending batch. Returns the server-assigned session id so
-- subsequent batches attach to the same session.
local function _flushPlayer(player: Player, buffer: BufferData)
	local hasEvents = #buffer.events > 0
	local hasFeedback = #buffer.feedback > 0
	if not (hasEvents or hasFeedback or buffer.ended) then
		return
	end

	local payload = {
		session_id = buffer.sessionId,
		player_id = player.UserId, -- hashed + anonymized server-side, never stored raw
		server_id = (game.JobId ~= "" and game.JobId) or "studio", -- which live server; "studio" in-editor
		started_at = buffer.startedAt,
		events = buffer.events,
		feedback = buffer.feedback,
		ended = buffer.ended,
	}

	local ok, response = pcall(function()
		return HttpService:RequestAsync({
			Url = config.endpoint .. "/ingest",
			Method = "POST",
			Headers = {
				["Content-Type"] = "application/json",
				["x-api-key"] = config.apiKey,
			},
			Body = HttpService:JSONEncode(payload),
		})
	end)

	if not ok then
		warn("[Telemetry] flush failed (network):", response)
		return
	end

	if not response.Success then
		warn("[Telemetry] flush rejected:", response.StatusCode, response.Body)
		return
	end

	-- Only clear the buffer once the server confirms receipt — no data loss on
	-- a transient failure, we just retry the same events next tick.
	local decoded = HttpService:JSONDecode(response.Body)
	if decoded.session_id then
		buffer.sessionId = decoded.session_id
	end
	buffer.events = {}
	buffer.feedback = {}
end

local function _flushAll()
	for player, buffer in buffers do
		_flushPlayer(player, buffer)
		if buffer.ended then
			buffers[player] = nil
		end
	end
end

------------------// FUNCTIONS \\--------------------

function Telemetry.Configure(options: { endpoint: string?, apiKey: string?, flushInterval: number? })
	if options.endpoint then
		config.endpoint = options.endpoint
	end
	if options.apiKey then
		config.apiKey = options.apiKey
	end
	if options.flushInterval then
		config.flushInterval = math.max(1, options.flushInterval)
	end
end

function Telemetry.StartSession(player: Player)
	local buffer = _bufferFor(player)
	buffer.startedAt = os.time() * 1000
	buffer.ended = false
end

function Telemetry.Track(player: Player, eventName: string, properties: { [string]: any }?)
	if config.apiKey == "" then
		warn("[Telemetry] no apiKey configured — call Telemetry.Configure first.")
		return
	end
	local buffer = _bufferFor(player)
	if #buffer.events >= MAX_BUFFERED_EVENTS then
		return -- drop rather than grow unbounded between flushes
	end
	table.insert(buffer.events, {
		name = eventName,
		properties = properties,
		client_ts = os.time() * 1000,
	})
end

function Telemetry.SubmitFeedback(player: Player, content: string)
	if typeof(content) ~= "string" or #content == 0 then
		return
	end
	local buffer = _bufferFor(player)
	table.insert(buffer.feedback, { content = string.sub(content, 1, 2000) })
end

function Telemetry.EndSession(player: Player)
	local buffer = buffers[player]
	if not buffer then
		return
	end
	buffer.ended = true
	_flushPlayer(player, buffer)
	buffers[player] = nil
end

------------------// LIFECYCLE \\--------------------

function Telemetry.init()
	if running then
		return
	end
	if not RunService:IsServer() then
		error("[Telemetry] must be required from the server.")
	end
	running = true

	-- Auto-close sessions so a leaving player's last events aren't lost.
	Players.PlayerRemoving:Connect(function(player: Player)
		Telemetry.EndSession(player)
	end)

	-- Periodic background flush.
	task.spawn(function()
		while running do
			task.wait(config.flushInterval)
			local ok, err = pcall(_flushAll)
			if not ok then
				warn("[Telemetry] flush loop error:", err)
			end
		end
	end)

	-- Best-effort final flush on server shutdown.
	game:BindToClose(function()
		running = false
		_flushAll()
	end)
end

return Telemetry
