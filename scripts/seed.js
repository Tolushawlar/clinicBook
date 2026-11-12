import "dotenv/config";
import { SupabaseStore } from "../src/supabaseStore.js";

function at(dayOffset, hour) {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour, 0, 0, 0);
  return date;
}

const providers = ["Dr Ade", "Dr Bello", "Dr Chen"];
const slots = [];
let index = 0;

for (let day = 1; day <= 5; day++) {
  for (let hour = 9; hour <= 15; hour += 2) {
    slots.push({
      id: `s${++index}`,
      provider: providers[(index + day + hour) % providers.length],
      start: at(day, hour).toISOString(),
      end: at(day, hour + 1).toISOString(),
    });
  }
}

const store = new SupabaseStore();
await store.reset(slots);

console.log(`Seeded ${slots.length} slots into Supabase`);
