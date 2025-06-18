import React, { useState } from 'react';
import { Modal, Input, Button, Alert } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { verifyAdminPassword } from '../utils/configManager';

const PasswordConfirm = ({ 
  visible, 
  onConfirm, 
  onCancel, 
  title = "패스워드 확인", 
  description = "계속하려면 패스워드를 입력하세요."
}) => {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!password.trim()) {
      setError('패스워드를 입력해주세요.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const result = await verifyAdminPassword(password);
      
      if (result.success) {
        onConfirm();
        setPassword('');
        setError('');
      } else {
        setError(result.message || '패스워드가 올바르지 않습니다.');
      }
    } catch (error) {
      console.error('패스워드 확인 오류:', error);
      setError('패스워드 확인 중 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    setPassword('');
    setError('');
    setLoading(false);
    onCancel();
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !loading) {
      handleSubmit();
    }
  };

  return (
    <Modal
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <LockOutlined />
          <span>{title}</span>
        </div>
      }
      open={visible}
      onCancel={handleCancel}
      footer={[
        <Button key="cancel" onClick={handleCancel} disabled={loading}>
          취소
        </Button>,
        <Button 
          key="confirm" 
          type="primary" 
          loading={loading}
          onClick={handleSubmit}
          disabled={!password.trim()}
        >
          확인
        </Button>
      ]}
      width={400}
      destroyOnClose={true}
      maskClosable={false}
    >
      <div style={{ padding: '16px 0' }}>
        <p style={{ marginBottom: '16px', color: '#666' }}>
          {description}
        </p>
        
        {error && (
          <Alert
            message={error}
            type="error"
            showIcon
            style={{ marginBottom: '16px' }}
          />
        )}
        
        <Input.Password
          placeholder="패스워드를 입력하세요"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setError('');
          }}
          onKeyPress={handleKeyPress}
          size="large"
          prefix={<LockOutlined style={{ color: '#bfbfbf' }} />}
          autoFocus
          disabled={loading}
        />
      </div>
    </Modal>
  );
};

export default PasswordConfirm; 