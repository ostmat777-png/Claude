-- Тест Lua-бэкенда плагина с заглушками модулей Millennium.
-- Запуск: lua tests/backend.test.lua   (из папки steam-price-chart; Lua 5.1+ или LuaJIT)
-- заглушки модулей Millennium
local calls = {}
package.preload["logger"] = function() return { info = function(self, m) end, error = function(self, m) end } end
local cfg = {}
package.preload["millennium"] = function() return {
  version = function() return "3.4.0" end, ready = function() return true end,
  config = { get = function(k) return cfg[k] end, set = function(k, v) cfg[k] = v; return true end },
} end
package.preload["http"] = function() return { get = function(url, opts)
  calls[#calls+1] = url
  if url:find("fail") then return nil, "timeout" end
  if url:find("boom") then error("libcurl exploded") end
  return { status = 200, body = 'ok "quoted"', headers = {} }
end } end
package.preload["cjson"] = function()
  local function enc(v)
    if type(v) == "table" then
      local parts = {}
      for k, x in pairs(v) do parts[#parts+1] = string.format("%q:%s", k, enc(x)) end
      table.sort(parts); return "{" .. table.concat(parts, ",") .. "}"
    elseif type(v) == "string" then return string.format("%q", v)
    else return tostring(v) end
  end
  return { encode = enc }
end
local dir = arg[1] or "millennium/backend"
package.path = dir .. "/?.lua;" .. package.path
local plugin = dofile(dir .. "/main.lua")
assert(type(plugin.on_load) == "function")
plugin.on_load()
local function check(name, got, want) print((got == want and "ok  " or "FAIL") .. " " .. name .. " -> " .. tostring(got)); if got ~= want then os.exit(1) end end
check("itad allowed", spcFetch("https://api.isthereanydeal.com/games/lookup/v1?key=x&appid=1"), '{"body":"ok \\"quoted\\"","status":200}')
check("cbr allowed", spcFetch("https://www.cbr-xml-daily.ru/daily_json.js"), '{"body":"ok \\"quoted\\"","status":200}')
check("evil host", spcFetch("https://evil.example.com/x"), '{"error":"host not allowed","status":0}')
check("host prefix trick", spcFetch("https://api.isthereanydeal.com.evil.com/x"), '{"error":"host not allowed","status":0}')
check("userinfo trick", spcFetch("https://api.isthereanydeal.com@evil.com/x"), '{"error":"host not allowed","status":0}')
check("http not https", spcFetch("http://api.isthereanydeal.com/x"), '{"error":"host not allowed","status":0}')
check("non-string", spcFetch(42), '{"error":"bad url","status":0}')
check("request nil", spcFetch("https://cdn.jsdelivr.net/fail"), '{"error":"timeout","status":0}')
check("request throws", spcFetch("https://cdn.jsdelivr.net/boom"):match('"status":0') ~= nil, true)
check("http calls made", #calls, 4)
check("get unset", spcGetSetting("itadKey"), "")
check("set", spcSetSetting("itadKey", "abc"), true)
check("get set", spcGetSetting("itadKey"), "abc")
check("unknown key set", spcSetSetting("evil", "x"), false)
check("unknown key get", spcGetSetting("evil"), "")
check("non-string value", spcSetSetting("homeRegion", 5), false)
print("ALL LUA TESTS PASSED")
