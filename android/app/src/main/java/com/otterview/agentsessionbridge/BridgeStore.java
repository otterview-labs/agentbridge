package com.otterview.agentsessionbridge;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;

import com.jcraft.jsch.HostKey;
import com.jcraft.jsch.HostKeyRepository;
import com.jcraft.jsch.UserInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;

/** Private, JSON-backed storage for the phone-first controller. */
final class BridgeStore {
  private static final String PREFS = "phone_controller_v1";
  private static final String KEY_MACHINES = "machines";
  private static final String KEY_TASKS = "tasks";
  private static final String KEY_FRP_SERVER = "frp_server";
  private static final String KEY_FRP_RELAYS = "frp_relays";
  private static final String KEY_HOST_KEYS = "host_keys";
  private static final String KEY_SEQUENCE = "id_sequence";

  private final SharedPreferences prefs;

  BridgeStore(Context context) {
    prefs = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  synchronized JSONArray machines() throws Exception {
    return new JSONArray(prefs.getString(KEY_MACHINES, "[]"));
  }

  synchronized void saveMachines(JSONArray value) {
    prefs.edit().putString(KEY_MACHINES, value.toString()).apply();
  }

  synchronized JSONArray tasks() throws Exception {
    return new JSONArray(prefs.getString(KEY_TASKS, "[]"));
  }

  synchronized JSONArray studioMemories() throws Exception {
    return new JSONArray(prefs.getString("studio_memories", "[]"));
  }

  synchronized void saveStudioMemories(JSONArray value) {
    if (!prefs.edit().putString("studio_memories", value.toString()).commit()) {
      throw new IllegalStateException("记忆保存失败，请检查手机存储空间");
    }
  }

  synchronized JSONObject studioModel() throws Exception {
    String value = prefs.getString("studio_model", "");
    return value == null || value.trim().isEmpty()
        ? new JSONObject() : new JSONObject(value);
  }

  synchronized void saveStudioModel(JSONObject value) {
    if (!prefs.edit().putString("studio_model", value.toString()).commit()) {
      throw new IllegalStateException("模型配置保存失败，请检查手机存储空间");
    }
  }

  synchronized JSONArray studioMessages() throws Exception {
    return new JSONArray(prefs.getString("studio_messages", "[]"));
  }

  synchronized void saveStudioMessages(JSONArray value) {
    if (!prefs.edit().putString("studio_messages", value.toString()).commit()) {
      throw new IllegalStateException("管家对话保存失败，请检查手机存储空间");
    }
  }

  synchronized JSONArray studioReports() throws Exception {
    return new JSONArray(prefs.getString("studio_reports", "[]"));
  }

  synchronized void saveStudioReports(JSONArray value) {
    if (!prefs.edit().putString("studio_reports", value.toString()).commit()) {
      throw new IllegalStateException("任务规划保存失败，请检查手机存储空间");
    }
  }

  synchronized void saveTasks(JSONArray value) {
    prefs.edit().putString(KEY_TASKS, value.toString()).apply();
  }

  synchronized JSONObject frpServer() throws Exception {
    String value = prefs.getString(KEY_FRP_SERVER, "");
    return value == null || value.trim().isEmpty() ? null : new JSONObject(value);
  }

  synchronized void saveFrpServer(JSONObject value) {
    prefs.edit().putString(KEY_FRP_SERVER, value.toString()).apply();
  }

  synchronized void clearFrpServer() {
    prefs.edit().remove(KEY_FRP_SERVER).apply();
  }

  synchronized JSONArray frpRelays() throws Exception {
    return new JSONArray(prefs.getString(KEY_FRP_RELAYS, "[]"));
  }

  synchronized void saveFrpRelays(JSONArray value) {
    prefs.edit().putString(KEY_FRP_RELAYS, value.toString()).apply();
  }

  synchronized JSONObject frpRelay(int machineId) throws Exception {
    JSONArray items = frpRelays();
    for (int index = 0; index < items.length(); index += 1) {
      JSONObject item = items.getJSONObject(index);
      if (item.getInt("machineId") == machineId) return item;
    }
    return null;
  }

  synchronized void updateFrpRelay(JSONObject relay) throws Exception {
    JSONArray items = frpRelays();
    boolean replaced = false;
    for (int index = 0; index < items.length(); index += 1) {
      if (items.getJSONObject(index).getInt("machineId") == relay.getInt("machineId")) {
        items.put(index, relay);
        replaced = true;
        break;
      }
    }
    if (!replaced) items.put(relay);
    saveFrpRelays(items);
  }

  synchronized JSONObject machine(int id) throws Exception {
    JSONArray items = machines();
    for (int index = 0; index < items.length(); index += 1) {
      JSONObject item = items.getJSONObject(index);
      if (item.getInt("id") == id) return item;
    }
    throw new IllegalArgumentException("机器不存在");
  }

  synchronized JSONObject task(int id) throws Exception {
    JSONArray items = tasks();
    for (int index = 0; index < items.length(); index += 1) {
      JSONObject item = items.getJSONObject(index);
      if (item.getInt("id") == id) return item;
    }
    throw new IllegalArgumentException("任务不存在");
  }

  synchronized int nextId() {
    int value = prefs.getInt(KEY_SEQUENCE, 0) + 1;
    prefs.edit().putInt(KEY_SEQUENCE, value).apply();
    return value;
  }

  synchronized void updateMachine(JSONObject machine) throws Exception {
    JSONArray items = machines();
    int id = machine.getInt("id");
    boolean replaced = false;
    for (int index = 0; index < items.length(); index += 1) {
      if (items.getJSONObject(index).getInt("id") == id) {
        items.put(index, machine);
        replaced = true;
        break;
      }
    }
    if (!replaced) items.put(machine);
    saveMachines(items);
  }

  synchronized void deleteMachine(int id) throws Exception {
    JSONArray machines = machines();
    JSONArray keptMachines = new JSONArray();
    for (int index = 0; index < machines.length(); index += 1) {
      if (machines.getJSONObject(index).getInt("id") != id) keptMachines.put(machines.get(index));
    }

    JSONArray tasks = tasks();
    JSONArray keptTasks = new JSONArray();
    for (int index = 0; index < tasks.length(); index += 1) {
      if (tasks.getJSONObject(index).getInt("machineId") != id) keptTasks.put(tasks.get(index));
    }
    saveMachines(keptMachines);
    saveTasks(keptTasks);

    JSONObject server = frpServer();
    if (server != null && server.getInt("machineId") == id) {
      clearFrpServer();
      saveFrpRelays(new JSONArray());
    } else {
      JSONArray relays = frpRelays();
      JSONArray keptRelays = new JSONArray();
      for (int index = 0; index < relays.length(); index += 1) {
        if (relays.getJSONObject(index).getInt("machineId") != id) keptRelays.put(relays.get(index));
      }
      saveFrpRelays(keptRelays);
    }
  }

  synchronized void replaceTasksForMachine(int machineId, JSONArray replacement) throws Exception {
    JSONArray all = tasks();
    JSONArray merged = new JSONArray();
    for (int index = 0; index < all.length(); index += 1) {
      if (all.getJSONObject(index).getInt("machineId") != machineId) merged.put(all.get(index));
    }
    for (int index = 0; index < replacement.length(); index += 1) merged.put(replacement.get(index));
    saveTasks(merged);
  }

  synchronized void updateTask(JSONObject task) throws Exception {
    JSONArray items = tasks();
    int id = task.getInt("id");
    for (int index = 0; index < items.length(); index += 1) {
      if (items.getJSONObject(index).getInt("id") == id) {
        items.put(index, task);
        saveTasks(items);
        return;
      }
    }
    items.put(task);
    saveTasks(items);
  }

  HostKeyRepository hostKeyRepository() {
    return new TrustOnFirstUseRepository();
  }

  private final class TrustOnFirstUseRepository implements HostKeyRepository {
    private Map<String, String> read() {
      Map<String, String> result = new HashMap<>();
      try {
        JSONObject values = new JSONObject(prefs.getString(KEY_HOST_KEYS, "{}"));
        JSONArray names = values.names();
        if (names == null) return result;
        for (int index = 0; index < names.length(); index += 1) {
          String name = names.getString(index);
          result.put(name, values.getString(name));
        }
      } catch (Exception ignored) {
        // Malformed persisted state is treated as no known hosts.
      }
      return result;
    }

    @Override
    public int check(String host, byte[] key) {
      String encoded = Base64.encodeToString(key, Base64.NO_WRAP);
      Map<String, String> known = read();
      String existing = known.get(host);
      if (existing == null) {
        try {
          JSONObject values = new JSONObject(prefs.getString(KEY_HOST_KEYS, "{}"));
          values.put(host, encoded);
          prefs.edit().putString(KEY_HOST_KEYS, values.toString()).apply();
        } catch (Exception ignored) {
          return HostKeyRepository.NOT_INCLUDED;
        }
        return HostKeyRepository.OK;
      }
      return existing.equals(encoded) ? HostKeyRepository.OK : HostKeyRepository.CHANGED;
    }

    @Override
    public void add(HostKey hostKey, UserInfo userInfo) {
      // check() persists the key on first use.
    }

    @Override
    public void remove(String host, String type) {
    }

    @Override
    public void remove(String host, String type, byte[] key) {
    }

    @Override
    public String getKnownHostsRepositoryID() {
      return "agent-bridge-phone";
    }

    @Override
    public HostKey[] getHostKey() {
      return new HostKey[0];
    }

    @Override
    public HostKey[] getHostKey(String host, String type) {
      return new HostKey[0];
    }

  }
}
