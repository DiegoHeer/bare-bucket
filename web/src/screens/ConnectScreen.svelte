<script lang="ts">
  import {
    createProfile,
    deleteProfile,
    listProfiles,
    saveProfile,
    type Profile,
  } from "../lib/profiles";
  import { session } from "../lib/session.svelte";

  let profiles = $state(listProfiles());
  let selectedId = $state<string | null>(null);
  let editing = $state<Profile | null>(null); // null = list mode
  let isNew = $state(false);
  let secret = $state("");

  const selected = $derived(profiles.find((p) => p.id === selectedId) ?? null);

  const emptyFields = {
    name: "",
    endpoint: "",
    region: "auto",
    bucket: "",
    accessKeyId: "",
    pathStyle: false,
  };

  function startAdd() {
    editing = { id: "", ...emptyFields };
    isNew = true;
  }

  function startEdit(profile: Profile) {
    editing = { ...profile };
    isNew = false;
  }

  function submitForm(event: SubmitEvent) {
    event.preventDefault();
    if (!editing) return;
    const { id: _id, ...fields } = editing;
    const saved = isNew ? createProfile(fields) : editing;
    saveProfile(saved);
    profiles = listProfiles();
    selectedId = saved.id;
    editing = null;
  }

  function remove(profile: Profile) {
    deleteProfile(profile.id);
    profiles = listProfiles();
    if (selectedId === profile.id) selectedId = null;
  }

  function select(profile: Profile) {
    selectedId = selectedId === profile.id ? null : profile.id;
    secret = "";
    session.clearError();
  }

  function connect(event: SubmitEvent) {
    event.preventDefault();
    if (selected && secret) void session.connect(selected, secret);
  }

  function endpointHost(profile: Profile): string {
    return profile.endpoint.replace(/^https?:\/\//, "");
  }
</script>

<main>
  <div class="card">
    <h1 class="wordmark">▙ bare<span>bucket</span></h1>

    {#if editing}
      <form class="profile-form" onsubmit={submitForm}>
        <label>Name <input bind:value={editing.name} required placeholder="R2 photos" /></label>
        <label>Endpoint <input bind:value={editing.endpoint} required placeholder="https://…" /></label>
        <div class="row">
          <label>Bucket <input bind:value={editing.bucket} required /></label>
          <label>Region <input bind:value={editing.region} required /></label>
        </div>
        <label>Access key ID <input bind:value={editing.accessKeyId} required /></label>
        <label class="checkbox">
          <input type="checkbox" bind:checked={editing.pathStyle} />
          Path-style addressing (MinIO / RustFS)
        </label>
        <div class="actions">
          <button type="submit" class="primary">{isNew ? "Add profile" : "Save changes"}</button>
          <button type="button" class="ghost" onclick={() => (editing = null)}>Cancel</button>
        </div>
      </form>
    {:else}
      <ul class="profiles">
        {#each profiles as profile (profile.id)}
          <li class:selected={profile.id === selectedId}>
            <button class="profile" onclick={() => select(profile)}>
              <span class="badge">{profile.name.slice(0, 2).toUpperCase()}</span>
              <span class="meta">
                <span class="name">{profile.name}</span>
                <span class="detail">{endpointHost(profile)} · {profile.bucket}</span>
              </span>
            </button>
            <span class="row-actions">
              <button class="icon" title="Edit" onclick={() => startEdit(profile)}>✎</button>
              <button class="icon" title="Remove" onclick={() => remove(profile)}>✕</button>
            </span>
          </li>
        {:else}
          <li class="empty">No profiles yet — add one to get started.</li>
        {/each}
      </ul>

      <button class="add" onclick={startAdd}>＋ Add profile</button>

      {#if selected}
        <form class="secret" onsubmit={connect}>
          <hr />
          <label>
            Secret access key for “{selected.name}”
            <input
              type="password"
              bind:value={secret}
              required
              autocomplete="off"
              placeholder="Session only — never stored"
            />
          </label>
          <button type="submit" class="primary" disabled={session.connecting || !secret}>
            {session.connecting ? "Connecting…" : "Connect"}
          </button>
        </form>
      {/if}

      {#if session.error}
        <p class="error">{session.error}</p>
      {/if}
    {/if}
  </div>
</main>

<style>
  main {
    display: grid;
    place-items: center;
    min-height: 100vh;
  }
  .card {
    width: min(420px, 92vw);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    padding: 24px;
    display: grid;
    gap: 12px;
  }
  .wordmark {
    text-align: center;
    color: var(--text-bright);
    font-size: 18px;
    margin: 0 0 4px;
  }
  .wordmark span {
    color: var(--accent);
  }
  .profiles {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .profiles li {
    display: flex;
    align-items: center;
    background: var(--input-bg);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
  }
  .profiles li.selected {
    border-color: var(--accent);
    background: var(--selected);
  }
  .profiles li.empty {
    justify-content: center;
    color: var(--text-dim);
    padding: 12px;
    border-style: dashed;
  }
  .profile {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 10px;
    background: none;
    border: none;
    color: inherit;
    padding: 9px 10px;
    text-align: left;
  }
  .badge {
    width: 30px;
    height: 30px;
    border-radius: var(--radius-small);
    background: var(--accent-soft);
    color: var(--accent-text);
    display: grid;
    place-items: center;
    font-weight: 700;
    flex-shrink: 0;
  }
  .meta {
    display: grid;
  }
  .name {
    color: var(--text-bright);
    font-weight: 600;
  }
  .detail {
    color: var(--text-dim);
    font-size: 12px;
  }
  .row-actions {
    display: flex;
    gap: 2px;
    padding-right: 6px;
    opacity: 0;
    transition: opacity 0.12s;
  }
  .profiles li:hover .row-actions,
  .profiles li.selected .row-actions {
    opacity: 1;
  }
  .icon {
    background: none;
    border: none;
    color: var(--text-dim);
    padding: 4px 6px;
    border-radius: 4px;
  }
  .icon:hover {
    color: var(--text-bright);
    background: var(--surface-raised);
  }
  .add {
    background: none;
    border: none;
    color: var(--accent);
    font-weight: 600;
    padding: 6px;
  }
  .profile-form,
  .secret {
    display: grid;
    gap: 10px;
  }
  label {
    display: grid;
    gap: 4px;
    color: var(--text-dim);
    font-size: 12px;
  }
  label.checkbox {
    grid-auto-flow: column;
    justify-content: start;
    align-items: center;
    gap: 8px;
    font-size: 13px;
  }
  input:not([type="checkbox"]) {
    background: var(--input-bg);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-small);
    color: var(--text-bright);
    padding: 8px 10px;
  }
  input:focus-visible {
    outline: 1px solid var(--accent);
  }
  .row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .actions {
    display: flex;
    gap: 8px;
  }
  .primary {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: var(--radius-small);
    padding: 9px 14px;
    font-weight: 700;
  }
  .primary:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .ghost {
    background: none;
    border: 1px solid var(--border-strong);
    color: var(--text-dim);
    border-radius: var(--radius-small);
    padding: 9px 14px;
  }
  hr {
    border: none;
    border-top: 1px solid var(--border);
    margin: 2px 0;
  }
  .error {
    color: var(--danger);
    font-size: 13px;
    margin: 0;
  }
</style>
