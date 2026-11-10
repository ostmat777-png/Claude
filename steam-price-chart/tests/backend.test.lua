-- Тест Lua-бэкенда плагина с заглушками модулей Millennium.
-- Запуск: lua tests/backend.test.lua   (из папки steam-price-chart; Lua 5.1+ или LuaJIT)

-- Ровно те модули, которые Millennium регистрирует для Lua-бэкенда
-- (src/lua_host/main.cc: register_preloaded_module). require() любого другого
-- модуля в Steam уронит плагин, поэтому здесь он тоже должен падать.
local REAL_MODULES = { json = true, millennium = true, http = true, utils = true,
                       logger = true, fs = true, regex = true, datetime = true }

local dir = arg[1] or "millennium/backend"
local calls, cfg = {}, {}

local stubs = {
  logger = { info = function(self, m) end, warn = function(self, m) end, error = function(self, m) end },
  millennium = {
    version = function() return "3.4.0" end,
    ready = function() return true end,
    config = { get = function(k) return cfg[k] end, set = function(k, v) cfg[k] = v; return true end },
  },
  http = { get = function(url, opts)
    calls[#calls + 1] = url
    if url:find("fail") then return nil, "timeout" end
    if url:find("boom") then error("libcurl exploded") end
    return { status = 200, body = 'ok "quoted"', headers = {} }
  end },
}

-- свой require: модули плагина из папки бэкенда, системные только из списка Millennium
local real_require = require
local loaded = {}
function require(name)
  if loaded[name] ~= nil then return loaded[name] end
  local f = io.open(dir .. "/" .. name .. ".lua", "r")
  if f then
    f:close()
    loaded[name] = dofile(dir .. "/" .. name .. ".lua") or true
  elseif REAL_MODULES[name] then
    loaded[name] = stubs[name] or {}
  else
    error("module '" .. name .. "' not found (Millennium has no such module)", 2)
  end
  return loaded[name]
end

-- таблица -> строка с отсортированными ключами, чтобы сравнивать ответы
local function enc(v)
  if type(v) == "table" then
    local parts = {}
    for k, x in pairs(v) do parts[#parts + 1] = string.format("%q:%s", k, enc(x)) end
    table.sort(parts)
    return "{" .. table.concat(parts, ",") .. "}"
  elseif type(v) == "string" then
    return string.format("%q", v)
  end
  return tostring(v)
end

local ok, plugin = pcall(dofile, dir .. "/main.lua")
if not ok then
  print("FAIL main.lua does not load: " .. tostring(plugin))
  os.exit(1)
end
assert(type(plugin) == "table", "main.lua must return a table")
assert(type(plugin.on_load) == "function")
plugin.on_load()

local function check(name, got, want)
  print((got == want and "ok   " or "FAIL ") .. name .. " -> " .. tostring(got))
  if got ~= want then os.exit(1) end
end

check("itad allowed", enc(spcFetch("https://api.isthereanydeal.com/games/lookup/v1?key=x&appid=1")), '{"body":"ok \\"quoted\\"","status":200}')
check("cbr allowed", enc(spcFetch("https://www.cbr-xml-daily.ru/daily_json.js")), '{"body":"ok \\"quoted\\"","status":200}')
check("evil host", enc(spcFetch("https://evil.example.com/x")), '{"error":"host not allowed","status":0}')
check("host prefix trick", enc(spcFetch("https://api.isthereanydeal.com.evil.com/x")), '{"error":"host not allowed","status":0}')
check("userinfo trick", enc(spcFetch("https://api.isthereanydeal.com@evil.com/x")), '{"error":"host not allowed","status":0}')
check("http not https", enc(spcFetch("http://api.isthereanydeal.com/x")), '{"error":"host not allowed","status":0}')
check("non-string", enc(spcFetch(42)), '{"error":"bad url","status":0}')
check("request nil", enc(spcFetch("https://cdn.jsdelivr.net/fail")), '{"error":"timeout","status":0}')
check("request throws", spcFetch("https://cdn.jsdelivr.net/boom").status, 0)
check("http calls made", #calls, 4)
check("get unset", enc(spcGetSetting("itadKey")), '{"value":""}')
check("set", spcSetSetting("itadKey", "12345"), true)
check("get set (digits stay a string)", enc(spcGetSetting("itadKey")), '{"value":"12345"}')
check("unknown key set", spcSetSetting("evil", "x"), false)
check("unknown key get", enc(spcGetSetting("evil")), '{"value":""}')
check("non-string value", spcSetSetting("homeRegion", 5), false)
print("ALL LUA TESTS PASSED")
