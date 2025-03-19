#!/bin/bash

# tidy-commits.sh - A script to help clean up commits before pushing
# This script offers an interactive rebase option to tidy up commits

# Get the current branch name
branch="$(git rev-parse --abbrev-ref HEAD)"
remote_branch="origin/$branch"

# Check if we're on main branch
if [ "$branch" = "main" ]; then
  echo "❌ You're on the main branch. Please checkout a feature branch to tidy commits."
  exit 1
fi

# Check if the branch exists on remote
if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  # Get the number of commits ahead of remote
  ahead=$(git rev-list --count "$remote_branch".."$branch")
  
  if [ "$ahead" -gt 0 ]; then
    echo "-------------------------------------------------------------------------------------"
    echo "🧹 You have $ahead commit(s) that will be pushed to the remote."
    echo "Starting interactive rebase for the last $ahead commit(s)..."
    echo ""
    echo "You can:"
    echo "  - Reorder commits by changing their order"
    echo "  - Edit commit messages with 'reword'"
    echo "  - Combine commits with 'squash' or 'fixup'"
    echo "  - Split or edit commits with 'edit'"
    echo "  - Remove commits by deleting their lines"
    echo "-------------------------------------------------------------------------------------"
    
    # Start interactive rebase
    git rebase -i HEAD~"$ahead"
    
    # Check if rebase was successful
    if [ $? -eq 0 ]; then
      echo "✅ Commits tidied up successfully!"
    else
      echo "❌ Rebase was aborted or had conflicts. Original commits remain unchanged."
      exit 1
    fi
  else
    echo "No unpushed commits found on branch '$branch'."
  fi
else
  # Branch doesn't exist on remote yet
  # Count all commits on this branch
  commit_count=$(git rev-list --count HEAD)
  
  echo "-------------------------------------------------------------------------------------"
  echo "🧹 This appears to be a new branch with $commit_count commit(s)."
  echo "Would you like to tidy up your commits before the first push? (y/n)"
  read -r answer
  
  if [[ "$answer" =~ ^[Yy]$ ]]; then
    # Find the fork point with main
    fork_point=$(git merge-base HEAD main)
    ahead=$(git rev-list --count $fork_point..HEAD)
    
    echo "Starting interactive rebase for $ahead commit(s) since branching from main..."
    echo ""
    echo "You can:"
    echo "  - Reorder commits by changing their order"
    echo "  - Edit commit messages with 'reword'"
    echo "  - Combine commits with 'squash' or 'fixup'"
    echo "  - Split or edit commits with 'edit'"
    echo "  - Remove commits by deleting their lines"
    echo "-------------------------------------------------------------------------------------"
    
    # Start interactive rebase from the fork point
    git rebase -i $fork_point
    
    # Check if rebase was successful
    if [ $? -eq 0 ]; then
      echo "✅ Commits tidied up successfully!"
    else
      echo "❌ Rebase was aborted or had conflicts. Original commits remain unchanged."
      exit 1
    fi
  else
    echo "Skipping commit cleanup."
  fi
fi