# Repository checkpoints

This file records the git tags we use as recovery points, along with the commands needed to inspect or restore them.

## Available checkpoints

### `checkpoint-2025-10-02`

- **Description:** Checkpoint before new changes
- **Inspect:**

  ```bash
  git show checkpoint-2025-10-02 --stat
  ```

- **Create branch at checkpoint:**

  ```bash
  git checkout -b restore-checkpoint-2025-10-02 checkpoint-2025-10-02
  ```

- **Reset current branch to checkpoint (destructive):**

  ```bash
  git reset --hard checkpoint-2025-10-02
  ```

### `checkpoint-2025-10-02b`

- **Description:** Checkpoint after tracker rename
- **Inspect:**

  ```bash
  git show checkpoint-2025-10-02b --stat
  ```

- **Create branch at checkpoint:**

  ```bash
  git checkout -b restore-checkpoint-2025-10-02b checkpoint-2025-10-02b
  ```

- **Reset current branch to checkpoint (destructive):**

  ```bash
  git reset --hard checkpoint-2025-10-02b
  ```

### `checkpoint-20250206`

- **Description:** Baseline tracker before solver exploration upgrades
- **Inspect:**

  ```bash
  git show checkpoint-20250206 --stat
  ```

- **Create branch at checkpoint:**

  ```bash
  git checkout -b restore-checkpoint-20250206 checkpoint-20250206
  ```

- **Reset current branch to checkpoint (destructive):**

  ```bash
  git reset --hard checkpoint-20250206
  ```
## Adding new checkpoints

1. Create a tag with a clear description:

   ```bash
   git tag -a checkpoint-YYYY-MM-DD -m "Brief description"
   ```

2. Push the tag if you want it on the remote:

   ```bash
   git push origin checkpoint-YYYY-MM-DD
   ```

3. Append the new tag details to this file.

