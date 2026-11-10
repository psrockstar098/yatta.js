import { col } from "../../../../types/db";

export const schema = {
      users: { id: col.id(), name: col.text() },
    };
