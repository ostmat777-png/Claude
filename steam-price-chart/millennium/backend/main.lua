local logger     = require("logger")
local millennium = require("millennium")

-- функции, которые вызывает скрипт на странице магазина
require("rpc_functions")

local function on_load()
    logger:info("Steam Price Chart loaded, Millennium " .. millennium.version())
    millennium.ready()
end

local function on_unload()
    logger:info("Steam Price Chart unloaded")
end

local function on_frontend_loaded()
end

return {
    on_load = on_load,
    on_unload = on_unload,
    on_frontend_loaded = on_frontend_loaded,
}
