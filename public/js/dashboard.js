document.addEventListener('DOMContentLoaded', function() {
    // DOM Elements
    const toggleBtn = document.getElementById('toggleBtn');
    const refreshBtn = document.getElementById('refreshBtn');
    const exportBtn = document.getElementById('exportBtn');
    const clearBtn = document.getElementById('clearBtn');
    const notification = document.getElementById('notification');
    const timeDisplay = document.getElementById('currentTime');

    // Update time
    function updateTime() {
        if (timeDisplay) {
            timeDisplay.textContent = new Date().toLocaleString();
        }
    }
    updateTime();
    setInterval(updateTime, 1000);

    // Toggle Collection
    toggleBtn.addEventListener('click', async function() {
        try {
            const response = await fetch('/api/toggle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const data = await response.json();
            
            showNotification(data.message, 'success');
            
            if (data.status === 'active') {
                this.textContent = '⏹️ Stop Collection';
                this.className = 'btn btn-danger';
                document.querySelector('.status-badge').textContent = '● active';
                document.querySelector('.status-badge').className = 'status-badge active';
            } else {
                this.textContent = '▶️ Start Collection';
                this.className = 'btn btn-success';
                document.querySelector('.status-badge').textContent = '● stopped';
                document.querySelector('.status-badge').className = 'status-badge stopped';
            }
            
            setTimeout(() => location.reload(), 1000);
        } catch (err) {
            showNotification('Error toggling collection: ' + err.message, 'error');
        }
    });

    // Refresh
    refreshBtn.addEventListener('click', function() {
        location.reload();
    });

    // Export CSV
    exportBtn.addEventListener('click', async function() {
        try {
            this.textContent = '⏳ Exporting...';
            this.disabled = true;
            
            const response = await fetch('/api/export');
            if (response.ok) {
                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `export_${new Date().toISOString().split('T')[0]}.csv`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                showNotification('Export successful!', 'success');
            }
        } catch (err) {
            showNotification('Error exporting: ' + err.message, 'error');
        } finally {
            this.textContent = '📥 Export CSV';
            this.disabled = false;
        }
    });

    // Clear Data
    clearBtn.addEventListener('click', async function() {
        if (!confirm('⚠️ Are you sure you want to delete ALL data? This cannot be undone!')) {
            return;
        }
        
        try {
            this.textContent = '⏳ Clearing...';
            this.disabled = true;
            
            const response = await fetch('/api/clear', {
                method: 'POST'
            });
            
            if (response.ok) {
                showNotification('All data cleared successfully!', 'success');
                setTimeout(() => location.reload(), 1500);
            }
        } catch (err) {
            showNotification('Error clearing data: ' + err.message, 'error');
        } finally {
            this.textContent = '🗑️ Clear Data';
            this.disabled = false;
        }
    });

    // Delete individual record
    document.querySelectorAll('.btn-delete').forEach(btn => {
        btn.addEventListener('click', async function() {
            const id = this.dataset.id;
            if (!confirm('Delete this record?')) return;
            
            try {
                const response = await fetch(`/api/record/${id}`, {
                    method: 'DELETE'
                });
                
                if (response.ok) {
                    this.closest('tr').remove();
                    showNotification('Record deleted!', 'success');
                }
            } catch (err) {
                showNotification('Error deleting: ' + err.message, 'error');
            }
        });
    });

    // Notification system
    function showNotification(message, type = 'success') {
        notification.textContent = message;
        notification.style.display = 'block';
        notification.style.background = type === 'success' ? '#d4edda' : '#f8d7da';
        notification.style.color = type === 'success' ? '#155724' : '#721c24';
        notification.style.border = type === 'success' ? '1px solid #c3e6cb' : '1px solid #f5c6cb';
        
        setTimeout(() => {
            notification.style.display = 'none';
        }, 5000);
    }

    // Auto-refresh every 60 seconds
    setInterval(() => {
        if (!document.hidden) {
            fetch('/api/stats')
                .then(res => res.json())
                .then(data => {
                    // Update stats without reload
                    document.querySelector('.stat-card:nth-child(1) .stat-number').textContent = data.totalRecords;
                    document.querySelector('.stat-card:nth-child(2) .stat-number').textContent = data.uniqueAccounts;
                    document.querySelector('.stat-card:nth-child(3) .stat-number').textContent = data.todayRecords;
                })
                .catch(err => console.error('Auto-refresh error:', err));
        }
    }, 60000);
});