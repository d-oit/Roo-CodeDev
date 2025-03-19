# Git Workflow Guide

## Tidying Up Commits Before Pushing

This project includes a helpful script to tidy up your commits before pushing them to a remote branch. This helps maintain a clean and meaningful commit history.

### How to Use

Run the following command when you want to clean up your commits:

```bash
npm run tidy-commits
```

This will:

1. Check if you have unpushed commits on your current branch
2. Start an interactive rebase session to let you organize those commits
3. Guide you through the process with helpful instructions

### Available Rebase Commands

During the interactive rebase, you can use these commands:

- `pick`: Use the commit as is
- `reword`: Use the commit but edit the commit message
- `edit`: Use the commit but stop for amending (allows splitting commits)
- `squash`: Combine with the previous commit (keeps both commit messages)
- `fixup`: Combine with the previous commit (discards this commit's message)
- `exec`: Run a command using shell

### Best Practices

- **Squash related changes**: Combine multiple small commits that relate to a single feature
- **Write clear commit messages**: Each commit should clearly describe what changed and why
- **Keep commits focused**: Each commit should represent a single logical change
- **Reorder commits**: Place related commits together for better readability

### Example Workflow

```bash
# Make multiple commits while working
git commit -m "Add new feature"
git commit -m "Fix typo"
git commit -m "Improve performance"

# When ready to push, tidy up your commits first
npm run tidy-commits

# You'll see an editor with your commits listed:
# pick abc123 Add new feature
# pick def456 Fix typo
# pick ghi789 Improve performance

# You might change it to:
# pick abc123 Add new feature
# fixup def456 Fix typo
# pick ghi789 Improve performance

# Save and close the editor to complete the rebase
# Then push your cleaned-up commits
git push
```

Remember: Only rebase commits that haven't been pushed yet. Rebasing public history can cause problems for other contributors.
