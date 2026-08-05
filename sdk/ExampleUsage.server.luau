--[[
	ExampleUsage.server.luau
	Reference wiring for the Playtest Pulse SDK. Place in ServerScriptService.
	Shows the realistic shape of instrumenting a dungeon-crawler.
--]]

-------------------// SERVICES \\--------------------

local ServerScriptService = game:GetService("ServerScriptService")
local Players = game:GetService("Players")

-------------------// MODULES \\---------------------

local Telemetry = require(ServerScriptService.Telemetry)

-----------------// REFERENCES \\--------------------

--// Constants
local ENDPOINT = "http://localhost:3000" -- swap for your deployed URL
local API_KEY = "pk_replace_with_your_dashboard_key"

------------------// LIFECYCLE \\--------------------

Telemetry.Configure({
	endpoint = ENDPOINT,
	apiKey = API_KEY,
	flushInterval = 5,
})
Telemetry.init()

Players.PlayerAdded:Connect(function(player: Player)
	Telemetry.StartSession(player)
	Telemetry.Track(player, "session_start", { place_version = game.PlaceVersion })

	player.CharacterAdded:Connect(function(character: Model)
		Telemetry.Track(player, "character_spawned")

		local humanoid = character:WaitForChild("Humanoid") :: Humanoid
		humanoid.Died:Connect(function()
			Telemetry.Track(player, "player_died", {
				position = tostring(character:GetPivot().Position),
			})
		end)
	end)
end)

-- Example: call this from your own dungeon logic.
local function onLevelStarted(player: Player, level: number)
	Telemetry.Track(player, "level_started", { level = level })
end

-- Example: wire this to an in-game feedback textbox submission.
local function onFeedbackSubmitted(player: Player, text: string)
	Telemetry.SubmitFeedback(player, text)
end

return { onLevelStarted = onLevelStarted, onFeedbackSubmitted = onFeedbackSubmitted }
