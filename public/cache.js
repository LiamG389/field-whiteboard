// Keep large board data out of synchronous, quota-limited localStorage.
(() => {
  let database;
  function open() {
    return database ||= new Promise((resolve, reject) => {
      const request = indexedDB.open('field-boards', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('boards');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function read(key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const request = db.transaction('boards').objectStore('boards').get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function write(key, value) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('boards', 'readwrite');
      transaction.objectStore('boards').put(value, key);
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  }
  globalThis.FieldCache = { read, write };
})();
